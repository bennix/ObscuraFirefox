const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

class Engine {
  constructor(binary) {
    this.pending = new Map();
    this.sequence = 0;
    this.child = spawn(binary, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.log = '';
    this.child.stderr.on('data', chunk => { this.log = (this.log + chunk).slice(-4000); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error(`Obscura 引擎已退出。${this.log}`)));
    this.child.stdin.on('error', error => this.fail(error));
  }
  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('引擎响应超时，请重启应用后重试。'));
      }, 90000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(result.content?.map(item => item.text || '').join('\n'));
    return result;
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}
module.exports = { Engine };
