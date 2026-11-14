const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
async function main() {
  const output = process.env.OBSCURA_PACKAGE_OUTPUT || path.join(__dirname, 'dist/Obscura Desktop.app');
  const runtime = path.join(__dirname, 'runtime/nw/nwjs-sdk-v0.120.0-osx-arm64/nwjs.app');
  await fs.rm(output, { recursive: true, force: true });
  await fs.cp(runtime, output, { recursive: true, verbatimSymlinks: true });
  const contents = path.join(output, 'Contents');
  const resources = path.join(contents, 'Resources/app.nw');
  await fs.mkdir(resources, { recursive: true });
  const modules = (await fs.readdir(__dirname)).filter(name => name.endsWith('.cjs') && !['package.cjs', 'prepare-assets.cjs'].includes(name));
  for (const name of [...modules, 'package.json', 'native', 'extension', 'third-party', 'README.md', 'node_modules']) {
    await fs.cp(path.join(__dirname, name), path.join(resources, name), { recursive: true, verbatimSymlinks: true });
  }
  for (const name of ['mdm', 'media']) await fs.cp(path.join(__dirname, 'runtime', name), path.join(resources, 'runtime', name), { recursive: true, verbatimSymlinks: true });
  await fs.mkdir(path.join(resources, 'bin'), { recursive: true });
  for (const name of ['obscura', 'obscura-worker']) await fs.copyFile(path.resolve(__dirname, '../target/release', name), path.join(resources, 'bin', name));
  execFileSync('clang', ['-O2', path.join(__dirname, 'native/launcher.c'), '-o', path.join(contents, 'MacOS/Obscura')]);
  const iconset = path.join(__dirname, 'dist/Obscura.iconset');
  await fs.mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('/usr/bin/sips', ['-z', pixels, pixels, path.join(__dirname, 'native/icon.png'), '--out', path.join(iconset, name)], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources/app.icns')]);
  await fs.rm(iconset, { recursive: true, force: true });
  const plist = path.join(contents, 'Info.plist');
  const values = { CFBundleName: 'Obscura Desktop', CFBundleDisplayName: 'Obscura Desktop', CFBundleIdentifier: 'ai.obscura.desktop.local', CFBundleExecutable: 'Obscura', CFBundleShortVersionString: require('./package.json').version, CFBundleVersion: '4', CFBundleIconFile: 'app.icns' };
  for (const [key, value] of Object.entries(values)) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', output], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', output], { stdio: 'inherit' });
  console.log(output);
}
main().catch(error => { console.error(error.message); process.exit(1); });
