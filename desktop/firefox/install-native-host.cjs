const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function installNativeHost(directory, options = {}) {
  const hostDirectory = options.hostDirectory || path.join(os.homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts');
  await fs.mkdir(hostDirectory, { recursive: true, mode: 0o700 });
  const executable = path.join(directory, 'native-host');
  await fs.writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(__dirname, 'native-host.cjs'))} ${quote(directory)}\n`, { mode: 0o700 });
  await fs.chmod(executable, 0o700);
  const manifest = { name: 'ai.obscura.workspace', description: 'Obscura local workspace bridge', path: executable, type: 'stdio', allowed_extensions: ['workspace@obscura.local'] };
  await fs.writeFile(path.join(hostDirectory, 'ai.obscura.workspace.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return executable;
}
module.exports = { installNativeHost };
