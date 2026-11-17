const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function bundleFFmpeg(source = process.arch === 'x64' ? '/usr/local/bin/ffmpeg' : '/opt/homebrew/bin/ffmpeg') {
  const root = path.join(__dirname, 'runtime/media');
  await fs.mkdir(path.join(root, 'lib'), { recursive: true });
  const files = new Map();
  async function collect(original, destination) {
    const real = await fs.realpath(original);
    if (files.has(real)) return;
    const dependencies = execFileSync('/usr/bin/otool', ['-L', real], { encoding: 'utf8' }).split('\n').slice(destination.endsWith('.dylib') ? 2 : 1)
      .map(line => line.trim().split(' (compatibility')[0]).filter(name => name.startsWith('/opt/homebrew/') || name.startsWith('/usr/local/'));
    files.set(real, { original: real, destination, dependencies });
    await fs.copyFile(real, destination);
    await fs.chmod(destination, 0o755);
    for (const dependency of dependencies) await collect(dependency, path.join(root, 'lib', path.basename(dependency)));
  }
  await collect(source, path.join(root, 'ffmpeg'));
  for (const file of files.values()) {
    try { execFileSync('/usr/bin/codesign', ['--remove-signature', file.destination], { stdio: 'ignore' }); } catch {}
    const arguments = [];
    for (const dependency of file.dependencies) {
      const prefix = file.destination.endsWith('.dylib') ? '@loader_path/' : '@loader_path/lib/';
      arguments.push('-change', dependency, prefix + path.basename(dependency));
    }
    if (arguments.length) execFileSync('/usr/bin/install_name_tool', [...arguments, file.destination]);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', file.destination], { stdio: 'ignore' });
  }
  await fs.writeFile(path.join(root, 'FFMPEG-LICENSE.txt'), execFileSync(source, ['-L'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
}

if (require.main === module) bundleFFmpeg().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { bundleFFmpeg };
