const WebSocket = require('ws');

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closeListeners = new Set();
    this.closed = socket.readyState > 1;
    socket.on('error', () => {});
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params, message.sessionId);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('网页连接已关闭')); }
      this.pending.clear();
      for (const listener of this.closeListeners) { try { listener(); } catch {} }
    });
  }

  get open() { return !this.closed && this.socket.readyState === WebSocket.OPEN; }

  onClose(listener) {
    this.closeListeners.add(listener);
    if (this.closed) queueMicrotask(() => { if (this.closeListeners.delete(listener)) listener(); });
    return () => this.closeListeners.delete(listener);
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return new CDP(socket);
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      // A dead socket never answers; fail now instead of waiting for the 60 second timer.
      if (!this.open) { reject(new Error('网页连接已关闭')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`网页操作超时（${method}）`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => { if (error) this.fail(id, error); }); }
      catch (error) { this.fail(id, error); }
    });
  }

  fail(id, error) {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer); this.pending.delete(id);
    request.reject(new Error(`网页连接已关闭：${error.message}`));
  }

  close() { try { this.socket.close(); } catch {} }
}

module.exports = { CDP };
