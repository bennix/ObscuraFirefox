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
