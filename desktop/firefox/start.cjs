const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { launch } = require('../app.cjs');
const { FirefoxTools } = require('./tools.cjs');
const { installNativeHost } = require('./install-native-host.cjs');

async function start(options = {}) {
  const binary = options.binary || process.env.OBSCURA_FIREFOX_BIN;
  if (!binary) throw new Error('请设置 OBSCURA_FIREFOX_BIN 为已编译的 Firefox 可执行文件');
  await fs.access(binary);
  const directory = options.directory || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/Obscura Firefox') : process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), 'Obscura Firefox') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'obscura-firefox'));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!options.directory && process.platform === 'darwin') {
    const previous = path.join(os.homedir(), 'Library/Application Support/Obscura Desktop');
    for (const name of ['settings.json', 'dictionary.json', 'bookmarks.json']) {
      try { await fs.copyFile(path.join(previous, name), path.join(directory, name), require('node:fs').constants.COPYFILE_EXCL); }
      catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
    }
  }
  const profile = path.join(directory, 'profile');
  await fs.mkdir(path.join(profile, 'extensions'), { recursive: true, mode: 0o700 });
  const tools = new FirefoxTools();
  let browserVersion = options.browserVersion;
  if (!browserVersion) {
    try { browserVersion = (await fs.readFile(path.join(path.dirname(binary), '../Resources/application.ini'), 'utf8')).match(/^Version=(.+)$/m)?.[1].trim(); } catch {}
  }
  // options.binary is Firefox here; the backend's binary option refers to the
  // separate Rust engine and must retain its bundled default.
  const { binary: firefoxBinary, ...backendOptions } = options;
  const initialURL = options.url || 'https://www.google.com/';
  const backend = await launch({ ...backendOptions, directory, startupURL: /^https?:/i.test(initialURL) ? new URL(initialURL).href : null, extensionBridge: true, browserTools: tools, browserVersion });
  if (!backend) return null;
  let child;
  try {
    // Same Firefox engine build, newer built-in workspace: discard only startup
    // caches so upgrades load the new extension instead of cached resources.
    const workspaceVersion = JSON.parse(await fs.readFile(path.join(__dirname, 'manifest.json'), 'utf8')).version;
    const versionFile = path.join(directory, 'workspace-version');
    let previousWorkspaceVersion = '';
    try { previousWorkspaceVersion = await fs.readFile(versionFile, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previousWorkspaceVersion !== workspaceVersion) {
      await fs.rm(path.join(profile, 'startupCache'), { recursive: true, force: true });
      await fs.rm(path.join(profile, 'addonStartup.json.lz4'), { force: true });
      await fs.writeFile(versionFile, workspaceVersion, { mode: 0o600 });
    }
    await installNativeHost(directory);
    const config = await backend.settings.read();
    const defaults = (await fs.readFile(path.join(__dirname, 'privacy-prefs.js'), 'utf8')).replace('pref("privacy.resistFingerprinting.exemptedDomains", "");', `pref("privacy.resistFingerprinting.exemptedDomains", ${JSON.stringify(config.authCompatibility ? 'x.com,*.x.com' : '')});`);
    const prefs = defaults.replace(/^pref\(/gm, 'user_pref(') + '\n' + [
      ['browser.shell.checkDefaultBrowser', false],
      // Block external startup traffic until the extension installs the shared
      // proxy resolver. The local backend remains reachable for authenticated setup.
      ['network.proxy.type', 1],
      ['network.proxy.http', ''],
      ['network.proxy.ssl', ''],
      ['network.proxy.socks', '127.0.0.1'],
      ['network.proxy.socks_port', 9],
      ['network.proxy.socks_version', 5],
      ['network.proxy.no_proxies_on', 'localhost, 127.0.0.1, ::1'],
      ['network.proxy.failover_direct', false],
      ['browser.startup.homepage', 'https://www.google.com/'],
      ['browser.startup.page', 1]
    ].map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n') + '\n';
    await fs.writeFile(path.join(profile, 'user.js'), prefs, { mode: 0o600 });
    // Keep Windows' launcher attached to the real browser so its early handoff
    // does not close the local backend while Firefox is still starting.
    child = spawn(binary, [...(process.platform === 'win32' ? ['-wait-for-browser'] : []), '-no-remote', '-profile', profile, backend.startupURL || initialURL], { windowsHide: true, stdio: options.testing ? 'inherit' : 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.once('exit', () => backend.close('firefox-exit').catch(() => {}));
    return { ...backend, child, profile, close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        const terminate = force => {
          if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, timeout: 4000 }, () => {});
          else child.kill(force ? 'SIGKILL' : 'SIGTERM');
        };
        terminate(false);
        const timer = setTimeout(() => terminate(true), 5000);
        await exited.finally(() => clearTimeout(timer));
      }
      await backend.close('launcher-close');
    } };
  } catch (error) { child?.kill('SIGTERM'); await backend.close('launcher-failure'); throw error; }
}
if (require.main === module) start().then(app => {
  if (!app) return;
  const stop = () => app.close().catch(() => {});
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { start };
