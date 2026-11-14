const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function start(options = {}) {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const directory = options.directory || path.join(os.homedir(), 'Library/Application Support/Obscura Desktop');
  const root = path.resolve(__dirname, '..');
  const executable = path.join(root, 'runtime/nw/nwjs-sdk-v0.120.0-osx-arm64/nwjs.app/Contents/MacOS/nwjs');
  const child = spawn(executable, [root, `--user-data-dir=${path.join(directory, 'nw-profile')}`,
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--disable-quic', '--disable-features=TrackingProtection3pcd,ThirdPartyCookieDeprecationTrial', '--no-first-run'], {
    env: { ...process.env, OBSCURA_DATA_DIR: directory, OBSCURA_DEBUG_PORT: String(port) },
    stdio: options.stdio || 'inherit'
  });
  return { process: child, port, directory };
}

if (require.main === module) start().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { start };
