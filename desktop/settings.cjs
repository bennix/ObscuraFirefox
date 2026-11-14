const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { engines } = require('./navigation.cjs');
const defaults = ['anthropic/claude-sonnet-4.6', 'z-ai/glm-5v-turbo', 'openai/gpt-5.4'];
class Settings {
  constructor(directory, keychain = execute) {
    this.file = path.join(directory, 'settings.json'); this.keychain = keychain;
    this.service = 'ai.obscura.desktop.zenmux'; this.account = 'zenmux-api-key';
  }
  async key() {
    try { return (await this.keychain('/usr/bin/security', ['find-generic-password', '-a', this.account, '-s', this.service, '-w'])).stdout.trim(); }
    catch { return ''; }
  }
  async read() {
    let config;
    try { config = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { config = {}; }
    const models = Array.isArray(config.models) && config.models.length ? config.models : defaults;
    return { authCompatibility: config.authCompatibility === true, searchEngine: engines[config.searchEngine] ? config.searchEngine : 'google', translationLanguage: config.translationLanguage || '简体中文', models, model: models.includes(config.model) ? config.model : models[0], hasKey: !!(await this.key()), baseURL: 'https://zenmux.ai/api/v1', proxy: config.proxy || { mode: 'system', url: '' }, theme: ['dark', 'light', 'system'].includes(config.theme) ? config.theme : 'dark' };
  }
  async proxyURL() {
    try { return (await this.keychain('/usr/bin/security', ['find-generic-password', '-a', 'network-proxy', '-s', 'ai.obscura.desktop.proxy', '-w'])).stdout.trim(); }
    catch { return ''; }
  }
  async save(input) {
    const current = await this.read();
    const models = [...new Set((input.models || current.models).map(x => String(x).trim()).filter(Boolean))];
    if (!models.length || models.length > 50) throw new Error('请保留 1 到 50 个模型');
    let proxy = current.proxy;
    if (input.proxyMode) proxy = { ...proxy, mode: input.proxyMode === 'manual' ? 'manual' : 'system' };
    if (input.proxyURL?.trim()) {
      const url = new URL(input.proxyURL.trim());
      if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:'].includes(url.protocol)) throw new Error('代理地址需要使用 HTTP、HTTPS 或 SOCKS 协议');
      await this.keychain('/usr/bin/security', ['add-generic-password', '-U', '-a', 'network-proxy', '-s', 'ai.obscura.desktop.proxy', '-w', url.href]);
      url.username = ''; url.password = '';
      proxy.url = url.href;
    }
    if (proxy.mode === 'manual' && !proxy.url) throw new Error('请输入代理地址');
    if (input.apiKey?.trim()) await this.keychain('/usr/bin/security', ['add-generic-password', '-U', '-a', this.account, '-s', this.service, '-w', input.apiKey.trim()]);
    if (input.deleteKey) {
      try { await this.keychain('/usr/bin/security', ['delete-generic-password', '-a', this.account, '-s', this.service]); } catch {}
    }
    const model = input.model || current.model;
    const theme = ['dark', 'light', 'system'].includes(input.theme) ? input.theme : current.theme;
    const authCompatibility = input.authCompatibility === undefined ? current.authCompatibility : input.authCompatibility === true;
    const searchEngine = input.searchEngine === undefined ? current.searchEngine : input.searchEngine;
    if (!engines[searchEngine]) throw new Error('请选择支持的搜索引擎');
    const translationLanguage = String(input.translationLanguage || current.translationLanguage).trim().slice(0, 80);
    await fs.writeFile(this.file, JSON.stringify({ authCompatibility, searchEngine, translationLanguage, models, model: models.includes(model) ? model : models[0], proxy, theme }, null, 2), { mode: 0o600 });
    return this.read();
  }
}
module.exports = { Settings, defaults };
