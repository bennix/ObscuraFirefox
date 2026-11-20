const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyTransport } = require('../proxy.cjs');
const { readLocalProxy, configuredEndpoints } = require('../local-proxy.cjs');
const empty = '<dictionary> {\n}';
test('automatic routes prioritize system and preserve browser SOCKS remote DNS', async () => {
  const transport = new ProxyTransport({ read: async () => ({}) }, {
    readSystemProxy: async () => '<dictionary> {\n SOCKSEnable : 1\n SOCKSProxy : 127.0.0.1\n SOCKSPort : 1081\n}',
    readLocalProxy: async () => 'http://127.0.0.1:7890', environmentProxy: () => 'http://127.0.0.1:8888'
  });
  try { assert.deepEqual(await transport.browserRoute('https://chatgpt.com'), { type: 'socks', host: '127.0.0.1', port: 1081, proxyDNS: true, username: '', password: '' }); }
  finally { transport.close(); }
});
test('manual proxy stays authoritative', async () => {
  const transport = new ProxyTransport({ read: async () => ({ proxy: { mode: 'manual' } }), proxyURL: async () => 'http://127.0.0.1:9000' }, { readSystemProxy: async () => { throw Error('must not inspect'); } });
  try { assert.equal((await transport.browserRoute('https://claude.ai')).port, 9000); } finally { transport.close(); }
});
for (const platform of ['darwin', 'linux', 'win32']) test(`${platform} recognizes running core config without scanning ports`, async () => {
  const command = platform === 'win32' ? '"C:\\mihomo.exe" -f "/fixture/config.yaml"' : '/usr/bin/mihomo /usr/bin/mihomo -f /fixture/config.yaml';
  const routes = [];
  const result = await readLocalProxy({ platform, run: async () => ({ stdout: platform === 'win32' ? JSON.stringify(command) : command }), readFile: async file => { assert.equal(file, '/fixture/config.yaml'); return 'mixed-port: 7891\n'; }, probe: async route => { routes.push(route); return true; } });
  assert.equal(result, 'http://127.0.0.1:7891'); assert.equal(routes.length, 1);
});
test('local detection refuses ambiguous active clients', async () => {
  await assert.rejects(readLocalProxy({ run: async () => ({ stdout: '/usr/bin/mihomo /usr/bin/mihomo -f /a\n/usr/bin/clash /usr/bin/clash -f /b' }), readFile: async file => `mixed-port: ${file === '/a' ? 7890 : 7891}`, probe: async () => true }), /多个/);
  assert.deepEqual(configuredEndpoints('proxies:\n  - port: 9999\nmixed-port: 0\n'), []);
});
test('system lookup is single-flight during parallel browser requests', async () => {
  let count = 0;
  const transport = new ProxyTransport({ read: async () => ({}) }, { readSystemProxy: async () => { count++; return empty; }, readLocalProxy: async () => '' });
  try { await Promise.all(Array.from({ length: 20 }, () => transport.resolve('https://example.com'))); assert.equal(count, 1); } finally { transport.close(); }
});

test('an active configured local core with an unavailable listener never selects direct', async () => {
  await assert.rejects(readLocalProxy({ run: async () => ({ stdout: '/usr/bin/mihomo -f /fixture/config.yaml' }), readFile: async () => 'mixed-port: 7890', probe: async () => false }), /无法连接/);
});

test('environment SOCKS5 routing keeps DNS at the proxy for backend and browser', async () => {
  const previous = process.env.ALL_PROXY;
  process.env.ALL_PROXY = 'socks5://127.0.0.1:1082';
  const transport = new ProxyTransport({ read: async () => ({}) }, { readSystemProxy: async () => empty, environmentProxy: () => process.env.ALL_PROXY, readLocalProxy: async () => { throw Error('environment must win'); } });
  try {
    assert.equal(await transport.resolve('https://chatgpt.com'), 'socks5h://127.0.0.1:1082');
    assert.equal((await transport.browserRoute('https://chatgpt.com')).proxyDNS, true);
  } finally { transport.close(); if (previous === undefined) delete process.env.ALL_PROXY; else process.env.ALL_PROXY = previous; }
});

test('mixed listener offering HTTP 407 and anonymous SOCKS5 selects SOCKS5', async () => {
  const net = require('node:net');
  const server = net.createServer(socket => socket.once('data', data => {
    socket.end(data[0] === 5 ? Buffer.from([5, 0]) : 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const route = await readLocalProxy({ platform: 'linux', run: async () => ({ stdout: '/bin/mihomo -f /fixture.yaml' }),
      readFile: async () => 'mixed-port: ' + port });
    assert.equal(route, 'socks5h://127.0.0.1:' + port);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('system proxy selects an accessible anonymous desktop listener after an HTTP challenge', async () => {
  const net = require('node:net');
  const server = net.createServer(socket => socket.once('data', data => {
    socket.end(data[0] === 5 ? Buffer.from([5, 255]) : 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const transport = new ProxyTransport({ read: async () => ({}) }, {
    readSystemProxy: async () => '<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : ' + port + '\n}',
    readLocalProxy: async () => 'http://127.0.0.1:20001'
  });
  try {
    assert.deepEqual(configuredEndpoints('{"mixed-port":20001,"authentication":[]}'), ['http://127.0.0.1:20001','socks5h://127.0.0.1:20001']);
    assert.equal((await transport.browserRoute('https://www.google.com')).port, 20001);
  } finally { transport.close(); await new Promise(resolve => server.close(resolve)); }
});
