const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
async function packageApp(input, output = path.resolve(__dirname, '../dist/Obscura Firefox.app')) {
  if (!input || path.resolve(input) === path.resolve(output)) throw new Error('Provide a separate, source-built mach package application');
  await fs.access(path.join(input, 'Contents/MacOS/firefox'));
  const workspaceRelative = 'Contents/Resources/browser/obscura-workspace';
  let packedWorkspace = false;
  try { await fs.access(path.join(input, workspaceRelative, 'manifest.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.access(path.join(input, workspaceRelative + '.xpi'));
    packedWorkspace = true;
  }
  const desktop = path.resolve(__dirname, '..');
  const node = path.join(desktop, 'runtime/node-v26.13.1-darwin-arm64/bin/node');
  await fs.access(node);
  const staging = output + '.building';
  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(input, staging, { recursive: true, verbatimSymlinks: true });
  // Mozilla's packager converts extension directories to XPI archives.
  // Restore the resource directory used by the built-in registration.
  if (packedWorkspace) {
    execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(staging, workspaceRelative + '.xpi'), path.join(staging, workspaceRelative)]);
    await fs.rm(path.join(staging, workspaceRelative + '.xpi'));
  }
  const workspaceManifest = JSON.parse(await fs.readFile(path.join(staging, workspaceRelative, 'manifest.json'), 'utf8'));
  if (workspaceManifest.browser_specific_settings?.gecko?.id !== 'workspace@obscura.local') throw new Error('Unexpected built-in workspace identity');
  const contents = path.join(staging, 'Contents');
  // Stock Mozilla updates do not contain our built-in workspace or launcher.
  const distribution = path.join(contents, 'Resources/distribution');
  await fs.mkdir(distribution, { recursive: true });
  const policyPath = path.join(distribution, 'policies.json');
  let policy = {};
  try { policy = JSON.parse(await fs.readFile(policyPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  policy.policies = { ...policy.policies, DisableAppUpdate: true };
  await fs.writeFile(policyPath, JSON.stringify(policy, null, 2) + '\n');
  const resources = path.join(contents, 'Resources/obscura-desktop');
  await fs.mkdir(path.join(resources, 'bin'), { recursive: true });
  const modules = (await fs.readdir(desktop)).filter(name => name.endsWith('.cjs') && name !== 'package.cjs');
  for (const name of [...modules, 'package.json', 'extension', 'firefox', 'third-party', 'node_modules']) await fs.cp(path.join(desktop, name), path.join(resources, name), { recursive: true, verbatimSymlinks: true, filter: source => path.basename(source) !== 'ACCEPTANCE.md' });
  for (const name of ['mdm', 'media']) await fs.cp(path.join(desktop, 'runtime', name), path.join(resources, 'runtime', name), { recursive: true, verbatimSymlinks: true });
  await fs.copyFile(node, path.join(resources, 'bin/node'));
  for (const name of ['obscura', 'obscura-worker']) await fs.copyFile(path.resolve(desktop, '../target/release', name), path.join(resources, 'bin', name));
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', path.join(__dirname, 'launcher.c'), '-o', path.join(contents, 'MacOS/Obscura')]);
  const plist = path.join(contents, 'Info.plist');
  for (const [key, value] of Object.entries({ CFBundleName: 'Obscura', CFBundleDisplayName: 'Obscura', CFBundleIdentifier: 'ai.obscura.firefox', CFBundleExecutable: 'Obscura' })) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'pipe' }); }
    catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]); }
  }
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--preserve-metadata=entitlements,flags,runtime', '--sign', '-', staging], { stdio: 'inherit' });
  // Platform-passkey entitlements require a separately validated signing setup.
  // Keep ordinary local builds launchable instead of adding them to ad-hoc signatures.
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staging], { stdio: 'inherit' });
  await fs.access(path.join(staging, workspaceRelative, 'theme.css'));
  const backup = output + '.previous';
  await fs.rm(backup, { recursive: true, force: true });
  try { await fs.rename(output, backup); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.rename(staging, output);
  return output;
}
if (require.main === module) packageApp(process.argv[2], process.argv[3]).then(console.log).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { packageApp };
