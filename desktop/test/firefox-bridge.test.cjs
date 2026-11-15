const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { FirefoxTools } = require('../firefox/tools.cjs');

test('Firefox bridge authenticates, correlates replies and rejects disconnected calls', async t => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tools = new FirefoxTools();
  tools.attach(server, 'test-only-secret');
  t.after(async () => { await tools.close(); await new Promise(resolve => server.close(resolve)); });
  const endpoint = `ws://127.0.0.1:${server.address().port}/firefox-bridge`;
  const bad = new WebSocket(endpoint + '?token=incorrect');
  await once(bad, 'error');
  assert.equal(tools.browserClient.open, false);
  const ws = new WebSocket(endpoint + '?token=test-only-secret');
  await once(ws, 'open');
  ws.on('message', bytes => {
    const request = JSON.parse(bytes);
    ws.send(JSON.stringify({ id: request.id, result: { method: request.method, args: request.args } }));
  });
  const [a, b] = await Promise.all([tools.request('first', { n: 1 }), tools.request('second', { n: 2 })]);
  assert.deepEqual(a, { method: 'first', args: { n: 1 } });
  assert.deepEqual(b, { method: 'second', args: { n: 2 } });
  ws.removeAllListeners('message');
  const pending = tools.request('unanswered');
  const rejection = assert.rejects(pending, /disconnected/);
  ws.close();
  await rejection;
  assert.equal(tools.pending.size, 0);
  await assert.rejects(tools.request('offline'), /尚未连接/);
});

test('stopping a Firefox task releases pending requests', async t => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tools = new FirefoxTools(); tools.attach(server, 'test');
  t.after(async () => { await tools.close(); await new Promise(resolve => server.close(resolve)); });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/firefox-bridge?token=test`);
  await once(ws, 'open');
  ws.on('message', raw => { const request = JSON.parse(raw); if (request.method === 'browser_stop') ws.send(JSON.stringify({ id: request.id, result: 'Stopped' })); });
  const pending = tools.request('unanswered');
  const rejection = assert.rejects(pending, /已停止/);
  await tools.stop(); await rejection;
  assert.equal(tools.pending.size, 0);
});

test('local app starts with Firefox extension bridge without Chromium or CDP', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { launch } = require('../app.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-firefox-test-'));
  const app = await launch({ directory, testing: true, extensionBridge: true, browserVersion: 'test-version', browserTools: new FirefoxTools(), settings: { read: async () => ({ proxy: { mode: 'system' } }) } });
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const headers = { 'X-Obscura-Token': app.token };
  const before = await (await fetch(app.origin + '/health', { headers })).json();
  assert.equal(before.browserConnected, false);
  assert.equal(before.browserEngine, 'Firefox');
  const ws = new WebSocket(app.origin.replace('http:', 'ws:') + '/firefox-bridge?token=' + app.token);
  await once(ws, 'open');
  const after = await (await fetch(app.origin + '/health', { headers })).json();
  assert.equal(after.browserConnected, true);
  assert.equal(after.chrome, 'test-version');
  assert.equal((await fetch(app.origin + '/health')).status, 401);
});

test('Firefox extension preparation preserves media features and uses Firefox background APIs', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { prepareExtension } = require('../firefox/prepare-extension.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-firefox-extension-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await prepareExtension(directory, { origin: 'http://127.0.0.1:12345', token: 'fixture-secret' });
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json')));
  assert.equal(manifest.sidebar_action.default_panel, 'panel.html');
  assert.equal(manifest.background.service_worker, undefined);
  for (const file of ['image-viewer.js', 'youtube-ads.js', 'reading-page.js', 'downloads.js']) assert.ok((await fs.stat(path.join(directory, file))).size > 0);
  assert.match(await fs.readFile(path.join(directory, 'media-sniffer.js'), 'utf8'), /browser.webRequest/);
  assert.equal((await fs.stat(path.join(directory, 'bridge-config.js'))).mode & 0o777, 0o600);
});

test('native messaging returns only validated loopback connection data', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { bridgeInfo } = require('../firefox/native-host.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-native-host-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const token = 'a'.repeat(64);
  await fs.writeFile(path.join(directory, 'launcher.json'), JSON.stringify({ origin: 'http://127.0.0.1:1234', token, unrelated: 'private' }));
  assert.deepEqual(await bridgeInfo(directory), { origin: 'http://127.0.0.1:1234', token });
  await fs.writeFile(path.join(directory, 'launcher.json'), JSON.stringify({ origin: 'https://example.com', token }));
  await assert.rejects(bridgeInfo(directory), /Invalid local bridge/);
});

test('native key adapter focuses only the requested web tab and maps modifiers', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  let dispatched;
  const win = { document: { hasFocus: () => true }, gBrowser: {}, focus() {}, setTimeout, clearTimeout, windowUtils: { sendNativeKeyEvent(...args) { dispatched = args.slice(0, 5); args[5](); } } };
  const tab = { documentGlobal: win, linkedBrowser: { currentURI: { scheme: 'https' }, focus() {} } };
  const sandbox = { Cu: { importGlobalProperties() {} }, Services: { prefs: { getBoolPref: () => true } }, Cc: { '@mozilla.org/widget/macdocksupport;1': { getService: () => ({ activateApplication() {} }) } }, Ci: { nsIMacDockSupport: {} }, ChromeUtils: { importESModule: () => ({ ExtensionError: Error, ExtensionCommon: { ExtensionAPI: class {} } }) } };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../firefox/native-api.js'), 'utf8'), sandbox);
  const api = new sandbox.obscuraNative().getAPI({ extension: { tabManager: { get: id => { assert.equal(id, 7); return { nativeTab: tab }; } } } }).obscuraNative;
  await api.pressKey(7, 'Meta+a');
  assert.deepEqual(dispatched, [0, 0, 0x4000, 'a', 'a']);
  assert.equal(win.gBrowser.selectedTab, tab);
  await assert.rejects(api.pressKey(7, 'UnknownKey'), /Unsupported/);
  tab.linkedBrowser.currentURI.scheme = 'about';
  await assert.rejects(api.pressKey(7, 'Enter'), /HTTP/);
});

test('upload resolves only a stored attachment and does not forward arbitrary file paths', async () => {
  const tools = new FirefoxTools();
  tools.attachments = { get: async (id, data) => { assert.equal(id, 'chosen-id'); assert.equal(data, true); return { name: 'chosen.txt', size: 1, data: 'eA==' }; } };
  tools.request = async (method, args) => { assert.equal(method, 'browser_upload'); assert.equal(args.path, undefined); assert.equal(args.file.name, 'chosen.txt'); return 'uploaded'; };
  const result = await tools.call('browser_upload', { attachmentId: 'chosen-id', selector: 'input[type=file]', path: '/private/unrelated' });
  assert.match(result.content[0].text, /uploaded/);
});

test('browser requests retain task tab identity and expose download context', async t => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tools = new FirefoxTools(); tools.attach(server, 'fixture');
  t.after(async () => { await tools.close(); await new Promise(resolve => server.close(resolve)); });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/firefox-bridge?token=fixture`);
  await once(ws, 'open');
  tools.currentPage = { tabId: 17 };
  ws.on('message', raw => {
    const request = JSON.parse(raw);
    assert.equal(request.targetTabId, 17);
    const result = request.method === 'target' ? { id: 17, url: 'https://example.com/video' } : 'fixture-agent';
    ws.send(JSON.stringify({ id: request.id, result }));
  });
  const page = await tools.page();
  assert.equal(page.url(), 'https://example.com/video');
  assert.equal(await page.evaluate(() => navigator.userAgent), 'fixture-agent');
});

test('native host handles fragmented messages and never echoes rejected input', async t => {
  const { PassThrough } = require('node:stream');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { serve } = require('../firefox/native-host.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-host-framing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const token = 'b'.repeat(64);
  await fs.writeFile(path.join(directory, 'launcher.json'), JSON.stringify({ origin: 'http://127.0.0.1:4321', token }));
  const input = new PassThrough(), output = new PassThrough();
  serve(input, output, directory);
  const packet = message => { const body = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); };
  const first = packet({ type: 'bridge' });
  const received = once(output, 'data');
  input.write(first.subarray(0, 2)); input.write(first.subarray(2, 6)); input.write(first.subarray(6));
  const [bytes] = await received;
  assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
  assert.deepEqual(JSON.parse(bytes.subarray(4)), { origin: 'http://127.0.0.1:4321', token });
  const rejected = once(output, 'data');
  input.write(packet({ type: 'invalid', secret: 'must-not-echo' }));
  const [failure] = await rejected;
  assert.doesNotMatch(failure.toString(), /must-not-echo/);
  assert.ok(JSON.parse(failure.subarray(4)).error);
  input.destroy(); output.destroy();
});
