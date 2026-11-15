const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ProxyAgent } = require('proxy-agent');

const execute = promisify(execFile);

function parseSystemProxy(text, target) {
  const values = {};
  let depth = 0;
  for (const line of text.split('\n')) {
    if (depth === 1) {
      const match = line.match(/^\s*(\w+)\s+:\s+(.+?)\s*$/);
      if (match) values[match[1]] = match[2];
    }
    if (line.trim().endsWith('{')) depth++;
    if (line.trim() === '}') depth--;
  }
  if (values.ProxyAutoConfigEnable === '1' && values.ProxyAutoConfigURLString) {
    return 'pac+' + values.ProxyAutoConfigURLString;
  }
  const protocol = new URL(target).protocol === 'https:' ? 'HTTPS' : 'HTTP';
  if (values[protocol + 'Enable'] === '1') {
    return `http://${values[protocol + 'Proxy']}:${values[protocol + 'Port']}`;
  }
  if (values.SOCKSEnable === '1') return `socks5h://${values.SOCKSProxy}:${values.SOCKSPort}`;
  if (values.ProxyAutoDiscoveryEnable === '1') throw new Error('系统启用了代理自动发现，请在设置中指定代理地址以连接 AI');
  return '';
}

class ProxyTransport {
  constructor(settings, { readSystemProxy = require('./system-proxy.cjs').readNativeSystemProxy } = {}) {
    this.settings = settings;
    this.readSystemProxy = readSystemProxy;
    this.cachedAt = 0;
    this.agent = new ProxyAgent({ getProxyForUrl: url => this.resolve(url) });
  }

  async resolve(url) {
    const config = await this.settings.read();
    if (config.proxy?.mode === 'manual') {
      const proxy = await this.settings.proxyURL();
      if (!proxy) throw new Error('手动代理尚未配置，请在设置中保存代理地址');
      return proxy.replace(/^socks5:/, 'socks5h:');
    }
    if (process.platform !== 'darwin' && ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'].some(key => process.env[key])) return require('proxy-from-env').getProxyForUrl(url);
    if (Date.now() - this.cachedAt > 3000) {
      this.system = await this.readSystemProxy();
      this.cachedAt = Date.now();
    }
    return parseSystemProxy(this.system, url);
  }

  async fetch(url, options) {
    try {
      const { default: fetch } = await import('node-fetch');
      return await fetch(url, { ...options, agent: this.agent });
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason;
      throw new Error('网络或代理连接失败，请检查代理 / VPN 状态', { cause: error });
    }
  }

  close() { this.agent.destroy(); }
}

async function resolvePacRoute(script, url) {
  const [{ createPacResolver }, { QuickJS }] = await Promise.all([import('pac-resolver'), import('quickjs-wasi')]);
  const vm = await QuickJS.create();
  try {
    const result = await createPacResolver(vm, script)(url);
    const route = result.split(';')[0].trim();
    if (route === 'DIRECT') return '';
    const match = route.match(/^(PROXY|HTTPS?|SOCKS5?|SOCKS4)\s+(.+)$/i);
    if (!match) throw new Error('代理脚本返回了不支持的路由');
    const scheme = { PROXY: 'http', HTTP: 'http', HTTPS: 'https', SOCKS: 'socks5h', SOCKS5: 'socks5h', SOCKS4: 'socks4' }[match[1].toUpperCase()];
    return `${scheme}://${match[2]}`;
  } finally { vm.dispose(); }
}

module.exports = { ProxyTransport, parseSystemProxy, resolvePacRoute };
