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
  constructor(settings, { readSystemProxy = require('./system-proxy.cjs').readNativeSystemProxy, readLocalProxy = require('./local-proxy.cjs').readLocalProxy, environmentProxy = require('proxy-from-env').getProxyForUrl } = {}) {
    this.settings = settings;
    this.readSystemProxy = readSystemProxy;
    this.readLocalProxy = readLocalProxy;
    this.environmentProxy = environmentProxy;
    this.cachedAt = 0;
    this.agent = new ProxyAgent({ getProxyForUrl: url => this.resolve(url) });
  }

  async resolve(url) {
    if (!this.configAt || Date.now() - this.configAt > 3000) {
      this.configRefresh ||= (async () => {
        this.config = await this.settings.read();
        this.manualURL = this.config.proxy?.mode === 'manual' ? await this.settings.proxyURL() : '';
        this.configAt = Date.now();
      })().finally(() => { this.configRefresh = null; });
      await this.configRefresh;
    }
    const config = this.config;
    if (config.proxy?.mode === 'manual') {
      const proxy = this.manualURL;
      if (!proxy) throw new Error('手动代理尚未配置，请在设置中保存代理地址');
      return proxy.replace(/^socks5:/, 'socks5h:');
    }
    if (Date.now() - this.cachedAt > 3000) {
      this.refresh ||= (async () => {
        this.system = await this.readSystemProxy();
        this.cachedAt = Date.now();
      })().finally(() => { this.refresh = null; });
      await this.refresh;
    }
    const system = parseSystemProxy(this.system, url);
    if (system) return system;
    // An explicit NO_PROXY decision must also bypass local auto detection.
    if (['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'].some(key => process.env[key])) return this.environmentProxy(url).replace(/^socks5:/, 'socks5h:');
    if (!this.localAt || Date.now() - this.localAt > 3000) {
      this.localRefresh ||= this.readLocalProxy().then(value => { this.local = value; this.localAt = Date.now(); }).finally(() => { this.localRefresh = null; });
      await this.localRefresh;
    }
    return this.local || '';
  }

  async browserRoute(url) {
    const target = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)) return { type: 'direct' };
    let route = await this.resolve(url.replace(/^ws/, 'http'));
    if (route.startsWith('pac+')) {
      const pacURL = route.slice(4);
      if (this.pacURL !== pacURL || Date.now() - this.pacAt > 30000) {
        const { default: fetch } = await import('node-fetch');
        const response = await fetch(pacURL, { signal: AbortSignal.timeout(10000), size: 1048576 });
        if (!response.ok) throw new Error('代理脚本读取失败');
        this.pacScript = await response.text(); this.pacURL = pacURL; this.pacAt = Date.now();
      }
      route = await resolvePacRoute(this.pacScript, url);
    }
    if (!route) return { type: 'direct' };
    const proxy = new URL(route);
    const type = { 'http:': 'http', 'https:': 'https', 'socks5:': 'socks', 'socks5h:': 'socks', 'socks4:': 'socks4' }[proxy.protocol];
    if (!type) throw new Error('不支持的代理类型');
    return { type, host: proxy.hostname, port: Number(proxy.port || (type === 'https' ? 443 : type === 'http' ? 80 : 1080)), proxyDNS: type === 'socks', username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) };
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
