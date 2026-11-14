#!/usr/bin/env python3
"""Sign a staged macOS distribution from the inside out."""
import argparse, pathlib, subprocess, tempfile, plistlib, shutil
p=argparse.ArgumentParser();p.add_argument('app');p.add_argument('--identity',required=True);a=p.parse_args()
root=pathlib.Path(a.app).resolve()
# PyInstaller distributions may flatten framework symlinks. Restore the
# versioned framework layout before codesign examines the bundle.
for framework in root.rglob('Python.framework'):
 versions=framework/'Versions'
 candidates=[f for f in versions.iterdir() if f.name!='Current' and f.is_dir()] if versions.is_dir() else []
 if len(candidates)!=1:raise RuntimeError(f'Unexpected Python framework layout: {framework}')
 for name,target in [('Versions/Current',candidates[0].name),('Python','Versions/Current/Python'),('Resources','Versions/Current/Resources')]:
  entry=framework/name
  if entry.is_symlink():continue
  if entry.is_dir():shutil.rmtree(entry)
  elif entry.exists():entry.unlink()
  entry.symlink_to(target)
magic={b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca',b'\xce\xfa\xed\xfe'}
with tempfile.TemporaryDirectory() as temp:
 ent=pathlib.Path(temp)/'runtime.plist'
 ent.write_bytes(plistlib.dumps({'com.apple.security.cs.allow-jit':True,'com.apple.security.cs.allow-unsigned-executable-memory':True}))
 def sign(path, executable=False):
  args=['codesign','--force','--timestamp','--options','runtime','--sign',a.identity]
  if executable:args+=['--entitlements',str(ent)]
  subprocess.run(args+[str(path)],check=True,stdout=subprocess.DEVNULL)
 paths=list(root.rglob('*'))
 for f in sorted(paths,key=lambda p:len(p.parts),reverse=True):
  if not f.is_file() or f.is_symlink():continue
  with f.open('rb') as stream:header=stream.read(4)
  if header in magic:sign(f, f.suffix not in ['.dylib','.so','.node'])
 for f in sorted(paths,key=lambda p:len(p.parts),reverse=True):
  if f.is_dir() and not f.is_symlink() and f.suffix in ['.app','.appex','.framework','.xpc']:
   sign(f, f.suffix in ['.app','.appex','.xpc'])
   subprocess.run(['codesign','--verify','--deep','--strict',str(f)],check=True)
 sign(root,True)
subprocess.run(['codesign','--verify','--deep','--strict',str(root)],check=True)
print('Developer ID signature verified')
