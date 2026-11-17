#!/usr/bin/env python3
"""Stage the Intel Mac runtime for a native Firefox source package."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request

repo = pathlib.Path(__file__).resolve().parents[2]
desktop = repo / 'desktop'
cache = desktop / 'runtime/macos-intel'
cache.mkdir(parents=True, exist_ok=True)
provenance = [{'engineWorkflowRun': os.environ.get('OBSCURA_ENGINE_RUN'), 'packageWorkflowRun': os.environ.get('GITHUB_RUN_ID'), 'workspaceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()}]


def download(url, name, digest=None):
    target = cache / name
    if not target.exists():
        with urllib.request.urlopen(url, timeout=120) as response, target.open('wb') as stream:
            shutil.copyfileobj(response, stream)
    actual = hashlib.file_digest(target.open('rb'), 'sha256').hexdigest()
    if digest and actual != digest.removeprefix('sha256:'):
        raise RuntimeError('Checksum mismatch: ' + name)
    provenance.append({'file': name, 'url': url, 'sha256': actual})
    return target


def asset(repository, tag, name):
    release = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repository}/releases/tags/{tag}'], text=True))
    item = next(item for item in release['assets'] if item['name'] == name)
    target = cache / name
    if not target.exists():
        subprocess.run(['gh', 'release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', str(cache)], check=True)
    return download(item['browser_download_url'], name, item.get('digest'))


def extract(archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as stream:
        stream.extractall(destination, filter='data')


version = '26.13.1'
node_name = f'node-v{version}-darwin-x64.tar.gz'
sums = urllib.request.urlopen(f'https://nodejs.org/dist/v{version}/SHASUMS256.txt', timeout=60).read().decode()
digest = next(line.split()[0] for line in sums.splitlines() if line.split()[-1] == node_name)
extract(download(f'https://nodejs.org/dist/v{version}/{node_name}', node_name, digest), desktop / 'runtime')

mdm = asset('anefzaoui/misterdownloadmanager', 'v0.5.2', 'MisterDownloadManager-0.5.2-macos-x86_64-experimental.dmg')
mount = cache / 'mdm-mounted'
mount.mkdir(exist_ok=True)
subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(mdm)], check=True)
try:
    application = next(mount.glob('*.app'))
    destination = desktop / 'runtime/mdm' / application.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ditto', str(application), str(destination)], check=True)
finally:
    subprocess.run(['hdiutil', 'detach', str(mount)], check=True)

media = desktop / 'runtime/media/yt-dlp'
media.mkdir(parents=True, exist_ok=True)
yt = asset('yt-dlp/yt-dlp', '2026.10.26', 'yt-dlp_macos')
shutil.copy2(yt, media / 'yt-dlp_macos')
(media / 'yt-dlp_macos').chmod(0o755)
subprocess.run(['node', 'desktop/prepare-media.cjs'], cwd=repo, check=True)

rust = cache / 'rust'
extract(asset('h4ckf0r0day/obscura', 'v0.2.6', 'obscura-x86_64-macos.tar.gz'), rust)
release = repo / 'target/release'
release.mkdir(parents=True, exist_ok=True)
for name in ['obscura', 'obscura-worker']:
    shutil.copy2(next(file for file in rust.rglob(name) if file.is_file()), release / name)
    (release / name).chmod(0o755)

third_party = desktop / 'third-party'
shutil.copy2(desktop / f'runtime/node-v{version}-darwin-x64/LICENSE', third_party / 'NODE-LICENSE.txt')
(third_party / 'BUILD-SOURCES.json').write_text(json.dumps(provenance, indent=2) + '\n')
print('Intel Mac helpers staged and checksummed')
