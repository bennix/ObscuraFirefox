const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const dictionary = values => '<dictionary> {\n' + Object.entries(values).map(([key, value]) => `  ${key} : ${value}`).join('\n') + '\n}';
async function readNativeSystemProxy({ platform = process.platform, run = execute } = {}) {
  if (platform === 'darwin') return (await run('/usr/sbin/scutil', ['--proxy'], { timeout: 3000 })).stdout;
  const values = {};
  if (platform === 'win32') {
    const script = "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,AutoConfigURL | ConvertTo-Json -Compress";
    const config = JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000, windowsHide: true })).stdout);
    if (config.AutoConfigURL) return dictionary({ ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: config.AutoConfigURL });
    if (config.ProxyEnable && config.ProxyServer) {
      const entries = config.ProxyServer.includes('=') ? config.ProxyServer.split(';') : ['http='+config.ProxyServer, 'https='+config.ProxyServer];
      for (const entry of entries) {
        const [scheme, endpoint] = entry.split('=');
        if (!endpoint) continue;
        const url = new URL('http://' + endpoint);
        const prefix = { http: 'HTTP', https: 'HTTPS', socks: 'SOCKS' }[scheme.toLowerCase()];
        if (prefix) Object.assign(values, { [prefix+'Enable']:1, [prefix+'Proxy']:url.hostname, [prefix+'Port']:url.port || 80 });
      }
    }
    return dictionary(values);
  }
  const get = async (schema, key) => (await run('gsettings', ['get', schema, key], { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim().replace(/^'|'$/g, '');
  let mode;
  try { mode = await get('org.gnome.system.proxy', 'mode'); }
  catch (error) { if (error.code === 'ENOENT' || /No such schema/.test(error.stderr || '')) return dictionary({}); throw error; }
  if (mode === 'auto') return dictionary({ ProxyAutoConfigEnable:1, ProxyAutoConfigURLString:await get('org.gnome.system.proxy','autoconfig-url') });
  if (mode === 'manual') for (const [scheme, prefix] of [['http','HTTP'],['https','HTTPS'],['socks','SOCKS']]) {
    const host = await get('org.gnome.system.proxy.'+scheme,'host');
    if (host) Object.assign(values, { [prefix+'Enable']:1, [prefix+'Proxy']:host, [prefix+'Port']:await get('org.gnome.system.proxy.'+scheme,'port') });
  }
  return dictionary(values);
}
module.exports = { readNativeSystemProxy };
