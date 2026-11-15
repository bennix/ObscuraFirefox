#!/usr/bin/env python3
"""Stage native Firefox with portable backend and platform-matched helpers."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tarfile, urllib.request, zipfile
p=argparse.ArgumentParser();p.add_argument('engine');p.add_argument('output');a=p.parse_args()
repo=pathlib.Path(__file__).resolve().parents[2]; desktop=repo/'desktop'; out=pathlib.Path(a.output).resolve()
windows=os.name=='nt'; suffix='.exe' if windows else ''; cache=repo/'desktop/runtime/cross-downloads';cache.mkdir(parents=True,exist_ok=True)
provenance=[]
def download(url, filename, digest=None):
 target=cache/filename
 if not target.exists():
  with urllib.request.urlopen(url,timeout=120) as response,target.open('wb') as stream:shutil.copyfileobj(response,stream)
 actual=hashlib.sha256(target.read_bytes()).hexdigest()
 if digest and actual!=digest.removeprefix('sha256:'):raise RuntimeError('Checksum mismatch: '+filename)
 provenance.append({'file':filename,'url':url,'sha256':actual});return target

def asset(repository, tag, name):
 url=f'https://api.github.com/repos/{repository}/releases/'+('latest' if tag=='latest' else 'tags/'+tag)
 headers={'Accept':'application/vnd.github+json','User-Agent':'ObscuraFirefox-build'}
 if os.environ.get('GH_TOKEN'):headers['Authorization']='Bearer '+os.environ['GH_TOKEN']
 release=json.load(urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=60))
 item=next(x for x in release['assets'] if x['name']==name)
 return download(item['browser_download_url'],name,item.get('digest'))

def extract(archive, destination):
 destination.mkdir(parents=True,exist_ok=True)
 if zipfile.is_zipfile(archive):
  with zipfile.ZipFile(archive) as z:
   for n in z.namelist():
    if not (destination/n).resolve().is_relative_to(destination.resolve()):raise RuntimeError('Invalid archive member')
   z.extractall(destination)
 else:
  with tarfile.open(archive) as t:t.extractall(destination,filter='data')

engine=pathlib.Path(a.engine).resolve(); temp=cache/'engine-extracted'
if engine.is_dir():
 candidates=[]
 for candidate in engine.rglob('*'):
  if not candidate.is_file():continue
  if zipfile.is_zipfile(candidate):
   with zipfile.ZipFile(candidate) as archive:names=set(archive.namelist())
  elif tarfile.is_tarfile(candidate):
   with tarfile.open(candidate) as archive:names=set(archive.getnames())
  else:continue
  if any(pathlib.PurePosixPath(name).name=='firefox'+suffix and str(pathlib.PurePosixPath(name).parent/'application.ini') in names for name in names):candidates.append(candidate)
 if len(candidates)!=1:raise RuntimeError('Expected one Firefox engine archive, found: '+str(candidates))
 engine=candidates[0]
print('Selected engine archive:',engine.name,flush=True)
provenance.append({'file':engine.name,'sha256':hashlib.sha256(engine.read_bytes()).hexdigest(),
 'engineWorkflowRun':os.environ.get('OBSCURA_ENGINE_RUN'),
 'workspaceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
 'packageWorkflowRun':os.environ.get('GITHUB_RUN_ID')})
if temp.exists():shutil.rmtree(temp)
extract(engine,temp)
root=next(f.parent for f in temp.rglob('firefox'+suffix) if f.is_file())
if out.exists():shutil.rmtree(out)
shutil.copytree(root,out,symlinks=True)
backend=out/'obscura-desktop';backend.mkdir()
for f in desktop.glob('*.cjs'):shutil.copy2(f,backend/f.name)
for name in ['package.json','node_modules','extension','firefox','third-party']:
 source=desktop/name;target=backend/name
 if source.is_dir():shutil.copytree(source,target,ignore=shutil.ignore_patterns('ACCEPTANCE.md','__pycache__'))
 else:shutil.copy2(source,target)
workspace=out/'browser/obscura-workspace'
archive=workspace.with_suffix('.xpi')
if archive.exists():archive.unlink()
subprocess.run(['node','-e',"require('./desktop/firefox/prepare-extension.cjs').prepareExtension(process.argv[1])",str(workspace)],cwd=repo,check=True)
(out/'distribution').mkdir(exist_ok=True)
(out/'distribution/policies.json').write_text(json.dumps({'policies':{'DisableAppUpdate':True}}))
version='26.13.1';node_name=f'node-v{version}-'+('win-x64.zip' if windows else 'linux-x64.tar.xz')
sums=urllib.request.urlopen(f'https://nodejs.org/dist/v{version}/SHASUMS256.txt',timeout=60).read().decode()
node_hash=next(line.split()[0] for line in sums.splitlines() if line.split()[-1]==node_name)
node_archive=download(f'https://nodejs.org/dist/v{version}/{node_name}',node_name,node_hash)
node_dir=cache/'node';extract(node_archive,node_dir)
node_binary=next(f for f in node_dir.rglob('node'+suffix) if f.is_file())
(backend/'bin').mkdir();shutil.copy2(node_binary,backend/'bin'/('node'+suffix))
mdm_name='MisterDownloadManager-0.5.2-'+('x64.zip' if windows else 'linux-x86_64.tar.gz')
mdm_dir=cache/'mdm';extract(asset('anefzaoui/misterdownloadmanager','v0.5.2',mdm_name),mdm_dir)
mdm_root=next(f.parent for f in mdm_dir.rglob('misterdownloadmanager'+suffix))
shutil.copytree(mdm_root,backend/'runtime/mdm',dirs_exist_ok=True)
media=backend/'runtime/media';(media/'yt-dlp').mkdir(parents=True)
ytname='yt-dlp.exe' if windows else 'yt-dlp_linux'
shutil.copy2(asset('yt-dlp/yt-dlp','2026.10.26',ytname),media/'yt-dlp'/ytname)
ffname='ffmpeg-master-latest-'+('win64-gpl.zip' if windows else 'linux64-gpl.tar.xz')
ffdir=cache/'ffmpeg';extract(asset('yt-dlp/FFmpeg-Builds','latest',ffname),ffdir)
for name in ['ffmpeg','ffprobe']:
 binary=next(f for f in ffdir.rglob(name+suffix) if f.is_file());shutil.copy2(binary,media/(name+suffix))
if not windows:
 linked=subprocess.run(['ldd',str(media/'ffmpeg')],capture_output=True,text=True)
 dependencies=linked.stdout+linked.stderr
 if any(name in dependencies for name in ['libavcodec','libavformat','libavutil','libavfilter','libswresample','libswscale']):
  raise RuntimeError('Bundled FFmpeg must not depend on system codec libraries')
 (media/'FFMPEG-LINKAGE.txt').write_text(dependencies)
(media/'FFMPEG-LICENSE.txt').write_bytes(subprocess.check_output([str(media/('ffmpeg'+suffix)),'-L'],stderr=subprocess.STDOUT))
# Keep the optional headless Rust engine available alongside the Firefox tools.
rust_name='obscura-x86_64-'+('windows.zip' if windows else 'linux.tar.gz')
rustdir=cache/'rust';extract(asset('h4ckf0r0day/obscura','v0.2.6',rust_name),rustdir)
for name in ['obscura','obscura-worker']:
 binary=next(f for f in rustdir.rglob(name+suffix) if f.is_file());shutil.copy2(binary,backend/'bin'/(name+suffix))
if not windows:
 for binary in [backend/'bin/node',media/'yt-dlp'/ytname,media/'ffmpeg',media/'ffprobe']:
  binary.chmod(0o755)
 launcher=out/'obscura'
 launcher.write_text('#!/bin/sh\nappdir="$(dirname "$(readlink -f "$0")")"\nexport OBSCURA_FIREFOX_BIN="$appdir/firefox"\nexec "$appdir/obscura-desktop/bin/node" "$appdir/obscura-desktop/firefox/start.cjs" "$@"\n')
 launcher.chmod(0o755)
for license_file in node_dir.rglob('LICENSE'):
 shutil.copy2(license_file,backend/'third-party/NODE-LICENSE.txt');break
(backend/'third-party/YT-DLP-LICENSE.txt').write_bytes(urllib.request.urlopen('https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.10.26/LICENSE',timeout=60).read())
(media/'FFMPEG-VERSION.txt').write_bytes(subprocess.check_output([str(media/('ffmpeg'+suffix)),'-version'],stderr=subprocess.STDOUT))
(backend/'third-party/BUILD-SOURCES.json').write_text(json.dumps(provenance,indent=2))
print(out)
