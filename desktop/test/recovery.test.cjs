const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { CDP } = require('../cdp.cjs');
const { NativeTools } = require('../native-tools.cjs');

// A minimal fake Chromium: /json/version, /json/list, a browser socket and one page socket.
async function fakeBrowser() {
  const calls = [], browserSockets = new Set(), pageSockets = new Set();
  let port;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/json/version') res.end(JSON.stringify({ Browser: 'Chrome/1', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/browser` }));
    else if (req.url === '/json/list') res.end(JSON.stringify([{ id: 'guest-1', type: 'webview', url: 'about:blank#obscura-popup-abc', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` }]));
    else { res.statusCode = 404; res.end('{}'); }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => {
    const kind = req.url === '/browser' ? 'browser' : 'page';
    (kind === 'browser' ? browserSockets : pageSockets).add(ws);
    ws.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      calls.push({ kind, method: message.method, params: message.params });
      ws.send(JSON.stringify({ id: message.id, result: message.method === 'Target.getTargets' ? { targetInfos: [] } : {} }));
    });
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    endpoint: `http://127.0.0.1:${port}`, calls, browserSockets, pageSockets,
    dropBrowser() { for (const ws of browserSockets) ws.terminate(); browserSockets.clear(); },
    async stop() { for (const ws of [...browserSockets, ...pageSockets]) ws.terminate(); sockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('CDP rejects immediately on a closed socket instead of waiting for the 60 second timer', async () => {
  const browser = await fakeBrowser();
  try {
    const client = await CDP.connect(browser.endpoint.replace('http', 'ws') + '/browser');
    const pending = client.send('Test.never');
    browser.dropBrowser();
    await assert.rejects(pending, /网页连接已关闭/);
    assert.equal(client.open, false);
    const started = Date.now();
    await assert.rejects(client.send('Page.enable'), /网页连接已关闭/);
    assert.ok(Date.now() - started < 500);
    let notified = false;
    client.onClose(() => { notified = true; });
    await until(() => notified);
    assert.equal(notified, true, 'late close listeners still run');
  } finally { await browser.stop(); }
});

test('CDP surfaces a synchronous socket send failure as a rejection', async () => {
  const listeners = {};
  const socket = { readyState: 1, on: (name, fn) => { listeners[name] = fn; }, send() { throw new Error('boom'); } };
  const client = new CDP(socket);
  await assert.rejects(client.send('Page.enable'), /boom/);
  assert.equal(client.pending.size, 0);
});

test('prepareGuest finds a marked guest without Target.getTargets and recovers from a dropped browser socket', async () => {
  const browser = await fakeBrowser();
  const tools = new NativeTools({ activeTarget: () => 'guest-1' });
  let lost = false;
  tools.onBrowserLost = () => { lost = true; };
  try {
    await tools.connect(browser.endpoint);
    browser.dropBrowser();
    await until(() => !tools.browserClient.open);
    // The popup path must work immediately, while the browser socket is down.
    const started = Date.now();
    const id = await tools.prepareGuest('obscura-popup-abc', 'opener-1');
    assert.equal(id, 'guest-1');
    assert.ok(Date.now() - started < 5000, 'no 60 second wait');
    assert.ok(!browser.calls.some(call => call.method === 'Target.getTargets'), 'marker lookup does not query browser targets');
    assert.ok(await until(() => tools.browserClient.open), 'browser socket is re-established');
    assert.equal(lost, false, 'recovery does not tear down the backend');
    assert.ok(tools.pages.get('guest-1'), 'page client survives');
    assert.equal((await tools.browserClient.send('Target.getTargets')).targetInfos.length, 0);
  } finally { tools.close(); await browser.stop(); }
});

test('browserSend retries through one shared reconnect and reports loss only when retries run out', async () => {
  const browser = await fakeBrowser();
  const tools = new NativeTools({});
  let lost = 0;
  tools.onBrowserLost = () => { lost++; };
  try {
    await tools.connect(browser.endpoint);
    browser.dropBrowser();
    await until(() => !tools.browserClient.open);
    const results = await Promise.all([tools.browserSend('Target.getTargets'), tools.browserSend('Target.getTargets')]);
    assert.equal(results.length, 2);
    assert.equal(lost, 0);
    tools.reconnectAttempts = 2; tools.reconnectInterval = 10;
    await browser.stop();
    await until(() => !tools.browserClient.open);
    await assert.rejects(tools.reconnectBrowser());
    assert.equal(lost, 1);
  } finally { tools.close(); await browser.stop().catch(() => {}); }
});

test('Google login compatibility is popup scoped and keeps native constructors only there', async () => {
  const tools = new NativeTools({});
  tools.endpoint = 'http://127.0.0.1:1';
  tools.pages.set('x-tab', { url: () => 'https://x.com/i/flow/login' });
  tools.pages.set('other-tab', { url: () => 'https://example.com/' });
  tools.pages.set('x-popup', { url: () => 'https://accounts.google.com/', googleLoginCompat: true });
  tools.authCompatibility = false;
  assert.equal(tools.googleLoginAllowed('x-tab'), false, 'needs the explicit X compatibility setting');
  tools.authCompatibility = true;
  assert.equal(tools.googleLoginAllowed('x-tab'), true);
  assert.equal(tools.googleLoginAllowed('x-popup'), true, 'a popup opened by the compatible popup stays scoped');
  assert.equal(tools.googleLoginAllowed('other-tab'), false);
  assert.equal(tools.googleLoginAllowed(undefined), false);
  assert.equal(tools.googleLoginAllowed('missing'), false);

  const privacy = fs.readFileSync(path.join(__dirname, '../extension/privacy.js'), 'utf8');
  const surface = (host, flag) => {
    const context = vm.createContext({ location: { hostname: host }, DOMException, HTMLCanvasElement: class { toDataURL() { return 'native'; } }, RTCPeerConnection: function () {}, OfflineAudioContext: function () {} });
    vm.runInContext('globalThis.navigator = {};', context);
    if (flag) vm.runInContext(`Object.defineProperty(globalThis,"${flag}",{value:true})`, context);
    vm.runInContext(privacy, context);
    return vm.runInContext('({rtc:typeof RTCPeerConnection,audio:typeof OfflineAudioContext,canvas:(()=>{try{return new HTMLCanvasElement().toDataURL()}catch(error){return error.name}})()})', context);
  };
  assert.equal(surface('accounts.google.com', '__obscuraGoogleLoginCompatibility').canvas, 'native');
  assert.equal(surface('accounts.google.com', '__obscuraGoogleLoginCompatibility').audio, 'function');
  assert.equal(surface('accounts.google.com', '__obscuraGoogleLoginCompatibility').rtc, 'function');
  const apple = vm.createContext({ location: { protocol: 'https:', hostname: 'appleid.apple.com', pathname: '/auth/authorize' }, DOMException, HTMLCanvasElement: class { toDataURL() { return 'native'; } }, RTCPeerConnection: function () {}, OfflineAudioContext: function () {} });
  vm.runInContext('globalThis.navigator = {}; Object.defineProperty(globalThis,"__obscuraGoogleLoginCompatibility",{value:true})', apple);
  vm.runInContext(privacy, apple);
  assert.equal(vm.runInContext('typeof RTCPeerConnection', apple), 'function');
  const appleHome = vm.createContext({ location: { protocol: 'https:', hostname: 'appleid.apple.com', pathname: '/' }, DOMException, HTMLCanvasElement: class { toDataURL() { return 'native'; } }, RTCPeerConnection: function () {}, OfflineAudioContext: function () {} });
  vm.runInContext('globalThis.navigator = {}; Object.defineProperty(globalThis,"__obscuraGoogleLoginCompatibility",{value:true})', appleHome);
  vm.runInContext(privacy, appleHome);
  assert.equal(vm.runInContext('typeof RTCPeerConnection', appleHome), 'undefined');
  assert.equal(surface('accounts.google.com').canvas, 'NotAllowedError');
  assert.equal(surface('challenges.cloudflare.com').canvas, 'native');
  for (const host of ['www.google.com', 'mail.google.com', 'accounts.youtube.com', 'x.com', 'example.com', 'accounts.google.com.evil.test', 'evilaccounts.google.com']) {
    const result = surface(host, '__obscuraGoogleLoginCompatibility');
    assert.equal(result.rtc, 'undefined');
    assert.equal(result.canvas, 'NotAllowedError', host);
  }
});

test('generated injection sources carry the Google flag only for approved popups', async () => {
  const browser = await fakeBrowser();
  const tools = new NativeTools({});
  tools.authCompatibility = true;
  try {
    await tools.connect(browser.endpoint);
    const flag = 'Object.defineProperty(globalThis,"__obscuraGoogleLoginCompatibility"';
    assert.ok(!tools.source.includes(flag));
    assert.ok(!tools.privacySource.includes(flag));
    const approved = tools.build(true);
    assert.ok(approved.source.includes(flag) && approved.privacySource.includes(flag));
    assert.ok(!tools.build(false).source.includes(flag));
  } finally { tools.close(); await browser.stop(); }
});
