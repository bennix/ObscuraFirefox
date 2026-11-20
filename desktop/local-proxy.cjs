const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const execute = promisify(execFile);

// Inspect only running, recognized cores and their explicitly selected config files.
function configuredEndpoints(text) {
  const endpoints = [];
  for (const [key, scheme] of [['mixed-port', 'http'], ['port', 'http'], ['socks-port', 'socks5h']]) {
    const match = text.match(new RegExp('^' + key + ':\\s*(\\d+)\\s*(?:#.*)?$', 'm'));
    if (match && +match[1] > 0 && +match[1] <= 65535) endpoints.push(`${scheme}://127.0.0.1:${+match[1]}`);
  }
  try {
    for (const inbound of JSON.parse(text).inbounds || []) {
      const scheme = { mixed: 'http', http: 'http', socks: 'socks5h' }[inbound.type || inbound.protocol];
      const port = inbound.listen_port || inbound.port;
      if (scheme && Number.isInteger(port) && port > 0 && port <= 65535 && ['127.0.0.1', '::1', 'localhost'].includes(inbound.listen || '127.0.0.1')) endpoints.push(`${scheme}://127.0.0.1:${port}`);
    }
  } catch {}
  return endpoints;
}
function available(endpoint) {
  return new Promise(resolve => {
    const url = new URL(endpoint);
    const socket = net.connect({ host: url.hostname, port: +url.port });
    let done = false;
    const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(700, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write(url.protocol === 'http:' ? 'CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n' : Buffer.from([5, 1, 0])));
    socket.once('data', data => finish(url.protocol === 'http:' ? /^HTTP\/1\.[01] \d{3}/.test(data.toString()) : data[0] === 5 && data[1] === 0));
    socket.on('end', () => finish(false));
  });
}
async function readLocalProxy({ platform = process.platform, run = execute, readFile = fs.readFile, probe = available } = {}) {
  let commands;
  try {
    if (platform === 'win32') {
      const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(mihomo|clash|sing-box|xray|v2ray)' } | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress";
      const result = JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3000, windowsHide: true })).stdout || '[]');
      commands = Array.isArray(result) ? result : [result];
    } else {
      commands = (await run('ps', ['-axo', 'args='], { timeout: 3000, maxBuffer: 2097152 })).stdout.split('\n').filter(line => /^\s*(?:\/[^\n]*?\/)?(?:mihomo|clash|sing-box|xray|v2ray)[\w.-]*(?:\s|$)/i.test(line));
    }
  } catch { return ''; }
  const routes = new Set();
  for (const command of commands) {
    if (!command) continue;
    const match = command.match(/(?:^|\s)(?:-f|--config|-c)\s+(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s+--?\w|$)/);
    const directory = command.match(/(?:^|\s)-d\s+(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s+--?\w|$)/);
    const file = match ? (match[1] || match[2] || match[3]).trim() : directory ? path.join((directory[1] || directory[2] || directory[3]).trim(), 'config.yaml') : '';
    if (!path.isAbsolute(file)) continue;
    try {
      const text = await readFile(file, 'utf8');
      if (Buffer.byteLength(text) > 4194304) continue;
      for (const route of configuredEndpoints(text)) {
        if (await probe(route)) { routes.add(route); break; }
      }
    } catch {}
  }
  if (routes.size > 1) throw new Error('检测到多个本地代理，请在网络设置中选择手动代理');
  return [...routes][0] || '';
}
module.exports = { readLocalProxy, configuredEndpoints };
