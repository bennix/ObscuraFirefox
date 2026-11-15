const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { definitions: commonDefinitions } = require('../chrome-tools.cjs');
const definitions = [...commonDefinitions.map(tool => ['browser_click', 'browser_fill'].includes(tool.name) ? { ...tool, description: tool.description + ' Returns an immediate post-action snapshot; inspect it before requesting another snapshot or screenshot. This snapshot is not a guarantee that asynchronous work has finished.' } : tool),
  { name: 'browser_upload', description: 'Upload a user-provided attachment to a file input. Use an attachment ID from the user message, never a filesystem path.', inputSchema: { type: 'object', properties: { attachmentId: { type: 'string' }, selector: { type: 'string' }, ref: { type: 'string' } }, required: ['attachmentId'] } },
  { name: 'browser_media', description: 'List media detected in the current task tab. Download only media selected by the user.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_tabs', description: 'List open browser tabs with IDs, titles and URLs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_select_tab', description: 'Select an existing browser tab by ID.', inputSchema: { type: 'object', properties: { tabId: { type: 'integer' } }, required: ['tabId'] } },
  { name: 'browser_new_tab', description: 'Open an HTTP(S) URL in a new tab.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_close_tab', description: 'Close a specified browser tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'integer' } }, required: ['tabId'] } }
];

// Firefox's extension owns tabs. No remote-debugging or WebDriver flags are needed.
class FirefoxTools {
  constructor() { this.definitions = definitions; this.pending = new Map(); this.browserClient = { open: false }; }
  attach(server, token) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 });
    this.upgrade = (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      const supplied = Buffer.from(url.searchParams.get('token') || '');
      const expected = Buffer.from(token);
      if (url.pathname !== '/firefox-bridge' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws));
    };
    this.server = server;
    server.on('upgrade', this.upgrade);
  }
  accept(ws) {
    this.socket?.close(1000, 'Replaced by current extension');
    this.rejectPending('Firefox bridge reconnected');
    this.socket = ws;
    this.browserClient.open = true;
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.event === 'auth-network') {
        try {
          const url = new URL(message.data.url);
          if (['x.com', 'twitter.com', 'jf.x.com', 'accounts.google.com', 'grok.com', 'challenges.cloudflare.com'].includes(url.hostname)) this.diagnostics?.record('firefox.network', { url: url.origin + url.pathname, method: String(message.data.method).slice(0, 10), status: Number(message.data.status) || 0, error: String(message.data.error || '').slice(0, 160), type: String(message.data.type).slice(0, 40) });
        } catch {}
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.finish();
      if (message.error) pending.reject(new Error(`${pending.method}: ${String(message.error)}`));
      else pending.resolve(message.result);
    });
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.browserClient.open = false;
      this.rejectPending('Firefox bridge disconnected');
    });
    ws.on('error', () => {});
  }
  rejectPending(reason) {
    for (const item of this.pending.values()) { item.finish(); item.reject(new Error(reason)); }
    this.pending.clear();
  }
  request(method, args = {}, signal = this.signal) {
    signal?.throwIfAborted();
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Firefox 工作台尚未连接'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { this.pending.delete(id); finish(); reject(signal.reason || new Error('操作已停止')); };
      const timer = setTimeout(() => { this.pending.delete(id); finish(); reject(new Error('Firefox 操作超时')); }, method === 'browser_navigate' ? 120000 : method === 'browser_stop' ? 5000 : 30000);
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, finish, method });
      signal?.addEventListener('abort', abort, { once: true });
      this.socket.send(JSON.stringify({ id, method, args, targetTabId: this.currentPage?.tabId }), error => {
        if (!error || !this.pending.delete(id)) return;
        finish(); reject(error);
      });
    });
  }
  async call(name, args = {}) {
    if (!definitions.some(tool => tool.name === name)) throw new Error('Unknown browser tool');
    if (name === 'browser_upload') {
      if (!this.attachments) throw new Error('附件服务不可用');
      const file = await this.attachments.get(args.attachmentId, true);
      args = { selector: args.selector, ref: args.ref, file };
    }
    const value = await this.request(name, args);
    if (['browser_select_tab', 'browser_new_tab'].includes(name)) this.currentPage = this.makePage(value);
    if (name === 'browser_close_tab' && this.currentPage?.tabId === args.tabId) this.currentPage = null;
    if (name === 'browser_screenshot') return { content: [{ type: 'image', mimeType: 'image/png', data: value.replace(/^data:image\/png;base64,/, '') }] };
    return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
  }
  cookies(url) { return this.request('cookies', { url }); }
  makePage(tab) {
    return { tabId: tab.id, url: () => tab.url, evaluate: (fn, arg) => this.request('browser_evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`, tabId: tab.id }) };
  }
  async page() {
    const tab = await this.request('target', { tabId: this.currentPage?.tabId, url: this.activeURL });
    return this.makePage(tab);
  }
  async stop() {
    this.rejectPending('操作已停止');
    if (this.socket?.readyState === WebSocket.OPEN) await this.request('browser_stop', {}, null).catch(() => {});
  }
  async close() {
    this.rejectPending('Firefox backend closed');
    this.server?.removeListener('upgrade', this.upgrade);
    this.socket?.terminate();
    this.wss?.close();
    this.browserClient.open = false;
  }
}
module.exports = { FirefoxTools, definitions };
