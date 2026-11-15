const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function installNativeHost(directory, options = {}) {
  const hostDirectory = options.hostDirectory || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts') : process.platform === 'win32' ? path.join(directory, 'NativeMessagingHosts') : path.join(os.homedir(), '.mozilla/native-messaging-hosts'));
  await fs.mkdir(hostDirectory, { recursive: true, mode: 0o700 });
  const executable = process.platform === 'win32' ? path.resolve(__dirname, '../bin/obscura-native-host.exe') : path.join(directory, 'native-host');
  if (process.platform !== 'win32') {
  await fs.writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(__dirname, 'native-host.cjs'))} ${quote(directory)}\n`, { mode: 0o700 });
  await fs.chmod(executable, 0o700);
  }
  const manifest = { name: 'ai.obscura.workspace', description: 'Obscura local workspace bridge', path: executable, type: 'stdio', allowed_extensions: ['workspace@obscura.local'] };
  await fs.writeFile(path.join(hostDirectory, 'ai.obscura.workspace.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  if (process.platform === 'win32') require('node:child_process').execFileSync('reg.exe', ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\ai.obscura.workspace', '/ve', '/t', 'REG_SZ', '/d', path.join(hostDirectory, 'ai.obscura.workspace.json'), '/f'], { windowsHide: true, stdio: 'ignore' });
  return executable;
}
module.exports = { installNativeHost };
