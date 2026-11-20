const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const backendRoot = process.env.OBSCURA_TEST_BACKEND || path.join(__dirname, '..');
const { start } = require(path.join(backendRoot, 'firefox/start.cjs'));

test('Firefox media targeting follows viewport geometry, scrolling and modal occlusion', { skip: !process.env.OBSCURA_FIREFOX_BIN, timeout: 90000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-media-viewport-'));
  const manifest = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts/ai.obscura.workspace.json')
    : process.platform === 'win32'
      ? path.join(directory, 'NativeMessagingHosts/ai.obscura.workspace.json')
      : path.join(os.homedir(), '.mozilla/native-messaging-hosts/ai.obscura.workspace.json');
  const previous = await fs.readFile(manifest).catch(() => null);
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Media viewport</title><style>body{margin:0}article{height:1600px}video{display:block;width:400px;height:240px;background:black}</style><article><a href="https://x.com/one/status/123"><time>One</time></a><div data-testid="videoPlayer"><video></video></div><p data-testid="tweetText">First video</p></article><article><a href="https://x.com/two/status/456"><time>Two</time></a><div data-testid="videoPlayer"><video></video></div><p data-testid="tweetText">Second video</p></article>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  t.after(async () => {
    await app?.close();
    await new Promise(resolve => server.close(resolve));
    if (previous) await fs.writeFile(manifest, previous);
    else await fs.rm(manifest, { force: true });
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  app = await start({ binary: process.env.OBSCURA_FIREFOX_BIN, directory, testing: true, url, settings: { read: async () => ({ proxy: { mode: 'system' } }) } });
  const deadline = Date.now() + 45000;
  while (!app.tools.browserClient.open && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(app.tools.browserClient.open);
  await app.tools.call('browser_navigate', { url });
  const source = await fs.readFile(path.join(__dirname, '../firefox/media-context.js'), 'utf8');
  // Use X identity with a local document to exercise real Firefox layout without a network fixture.
  const fixtureSource = source.replace("window.addEventListener('contextmenu',", 'captureContext(');
  const expression = `(async () => {
    let contextHandler;
    function captureContext(callback) { contextHandler = callback; }
    const location = new URL('https://x.com/home');
    let listener;
    const browser = { runtime: { onMessage: { addListener(callback) { listener = callback; } } } };
    ${fixtureSource}
    const first = await listener({ type: 'media-visible-x' });
    contextHandler({ target: document.querySelector('video'), stopImmediatePropagation() {} });
    const context = await listener({ type: 'media-context-target' });
    window.scrollTo(0, 1600);
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = await listener({ type: 'media-visible-x' });
    const overlay = document.createElement('div');
    overlay.style = 'position:fixed;inset:0;background:white;z-index:99999';
    document.body.append(overlay);
    const covered = await listener({ type: 'media-visible-x' });
    return { first, context, second, covered };
  })()`;
  const result = await app.tools.request('browser_evaluate', { expression });
  assert.deepEqual(result.first.media.map(item => item.url), ['https://x.com/one/status/123']);
  assert.equal(result.context.url, 'https://x.com/one/status/123');
  assert.deepEqual(result.second.media.map(item => item.url), ['https://x.com/two/status/456']);
  assert.deepEqual(result.covered.media, []);
  await t.test('quality form forwards the selected video and audio format', async () => {
    const html = await fs.readFile(path.join(__dirname, '../firefox/download-options.html'), 'utf8');
    const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
    const script = await fs.readFile(path.join(__dirname, '../firefox/download-options.js'), 'utf8');
    const form = await app.tools.request('browser_evaluate', { expression: `(async () => {
      document.body.innerHTML = ${JSON.stringify(body)};
      const messages = [];
      const location = { search: '?url=https%3A%2F%2Fx.com%2Fuser%2Fstatus%2F123' };
      const browser = {
        i18n: { getUILanguage: () => 'zh-CN' },
        runtime: { async sendMessage(message) {
          messages.push(message);
          if (message.type === 'media-inspect') return { title: 'Video', formats: [
            { id: '1080+audio', label: '1080p', height: 1080 },
            { id: '360+audio', label: '360p', height: 360 }
          ] };
          return { id: 'media-fixture' };
        } },
        obscuraNative: { async openDownloads() {} },
        tabs: { getCurrent: async () => ({ id: 1 }), async remove() {} }
      };
      ${script}
      await new Promise(resolve => setTimeout(resolve, 10));
      const options = [...document.getElementById('quality').options].map(option => option.textContent);
      document.getElementById('quality').value = '360+audio';
      document.getElementById('download-form').requestSubmit();
      await new Promise(resolve => setTimeout(resolve, 10));
      return { options, messages };
    })()` });
    assert.equal(form.options.length, 3);
    assert.equal(form.messages.find(message => message.type === 'native-download').args.format, '360+audio');
  });
  await t.test('clear list stays empty until the user scans again', async () => {
    const html = await fs.readFile(path.join(__dirname, '../extension/panel.html'), 'utf8');
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
    const script = await fs.readFile(path.join(__dirname, '../extension/downloads.js'), 'utf8');
    const list = await app.tools.request('browser_evaluate', { expression: `(async () => {
      document.body.innerHTML = ${JSON.stringify(body)};
      const $ = id => document.getElementById(id);
      const activeTab = { id: 1 };
      const target = async () => activeTab;
      const run = action => action();
      const status = () => {};
      let cleared = false;
      const request = async () => ({ downloads: [], folder: '/tmp/downloads' });
      const workspace = { async message(message) {
        if (message.type === 'media-clear') cleared = true;
        if (message.type === 'media-rescan') cleared = false;
        return { cleared, media: cleared ? [] : [{ url: 'https://x.com/user/status/123', title: 'Video', kind: 'X', host: 'x.com' }] };
      } };
      ${script}
      await refreshMedia();
      const before = document.querySelectorAll('.media-card').length;
      $('media-clear').click();
      await new Promise(resolve => setTimeout(resolve, 10));
      await refreshMedia();
      const afterClear = document.querySelectorAll('.media-card').length;
      const clearedText = $('media-list').textContent;
      $('media-refresh').click();
      await new Promise(resolve => setTimeout(resolve, 10));
      return { before, afterClear, clearedText, afterScan: document.querySelectorAll('.media-card').length };
    })()` });
    assert.equal(list.before, 1);
    assert.equal(list.afterClear, 0);
    assert.match(list.clearedText, /重新嗅探/);
    assert.equal(list.afterScan, 1);
  });
});
