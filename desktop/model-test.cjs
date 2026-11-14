const http = require('node:http');
const https = require('node:https');

function responseOf(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('error', reject);
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text });
    });
  });
}

function directRequest(target, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(target, { method: options.method, headers: options.headers, timeout: 20000 }, resolve);
    req.on('error', reject);
    options.signal?.addEventListener('abort', () => req.destroy(new Error('请求超时')), { once: true });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function proxiedRequest(target, proxy, options) {
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`, timeout: 20000
    });
    connect.on('error', reject);
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`代理拒绝连接（${res.statusCode}）`)); return; }
      const req = https.request({
        host: target.hostname, port: target.port || 443, path: `${target.pathname}${target.search}`,
        method: options.method, headers: options.headers, servername: target.hostname,
        socket, agent: false
      }, resolve);
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
    options.signal?.addEventListener('abort', () => connect.destroy(new Error('请求超时')), { once: true });
    connect.end();
  });
}

async function fetchModel(url, options, proxy) {
  const target = new URL(url);
  if (proxy.startsWith('pac+') || proxy.startsWith('socks')) throw new Error('请在设置中把代理改成手动 HTTP 代理，例如 http://127.0.0.1:7890');
  const res = proxy ? await proxiedRequest(target, new URL(proxy), options) : await directRequest(target, options);
  return responseOf(res);
}

async function probeModel({ key, model, baseURL = 'https://zenmux.ai/api/v1', fetcher, proxy = '', signal }) {
  if (!key) throw new Error('请先填写或保存 API Key');
  if (!model) throw new Error('请选择要测试的模型');
  const endpoint = `${String(baseURL).replace(/\/$/, '')}/chat/completions`;
  const request = {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with ok' }], max_tokens: 16 }),
    signal
  };
  let response;
  try {
    response = fetcher ? await fetcher(endpoint, request) : await fetchModel(endpoint, request, proxy);
  } catch (error) {
    const detail = error.cause?.code || error.code || error.cause?.message || '';
    throw new Error(['无法连接 ZenMux', error.message, detail].filter(Boolean).join('：'));
  }
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  if (!response.ok) {
    const message = payload?.error?.message || text.replace(/\s+/g, ' ').slice(0, 240) || '请求失败';
    return { ok: false, status: response.status, model, message };
  }
  const reply = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || '';
  return { ok: true, status: response.status, model: payload?.model || model, reply: String(reply).slice(0, 200) };
}

module.exports = { probeModel };
