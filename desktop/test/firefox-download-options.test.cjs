const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../firefox/download-options.js'), 'utf8');

async function fixture(download) {
  const nodes = new Map();
  const messages = [];
  let opened = 0;
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { disabled: false, hidden: false, value: '', replaceChildren(...options) { this.options = options; this.value = options[0].value; } });
    return nodes.get(id);
  } };
  const browser = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: { async sendMessage(message) {
      messages.push(message);
      if (message.type === 'media-inspect') return { title: 'Fixture', formats: [
        { id: 'video1080+audio/video1080', label: '1080p · mp4', videoOnly: true },
        { id: 'video360+audio/video360', label: '360p · mp4', videoOnly: true },
        { id: 'audio', label: 'Audio', audioOnly: true }
      ] };
      return download?.();
    } },
    obscuraNative: { async openDownloads() { opened++; } },
    tabs: { getCurrent: async () => ({ id: 1 }), remove: async () => {} }
  };
  vm.runInNewContext(source, { browser, document, URLSearchParams, location: { search: '?url=https%3A%2F%2Fx.com%2Fuser%2Fstatus%2F123' }, Option: class { constructor(label, value) { this.label = label; this.value = value; } } });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, messages, opened: () => opened, submit: () => nodes.get('download-form').onsubmit({ preventDefault() {} }) };
}

test('quality selection forwards the selected merged format and opens native downloads', async () => {
  const f = await fixture();
  assert.equal(f.nodes.get('quality').options.length, 3);
  f.nodes.get('quality').value = 'video360+audio/video360';
  await f.submit();
  const request = f.messages.find(message => message.type === 'native-download');
  assert.equal(request.args.format, 'video360+audio/video360');
  assert.equal(request.args.media, true);
  assert.equal(f.opened(), 1);
  await f.submit();
  assert.equal(f.messages.filter(message => message.type === 'native-download').length, 1);
});

test('best quality uses the downloader default and a failed start permits retry', async () => {
  let attempts = 0;
  const f = await fixture(async () => { if (++attempts === 1) throw new Error('Service unavailable'); });
  await f.submit();
  assert.equal(f.nodes.get('download').disabled, false);
  assert.match(f.nodes.get('status').textContent, /Service unavailable/);
  await f.submit();
  assert.equal(f.messages.at(-1).args.format, undefined);
  assert.equal(f.opened(), 1);
});

test('quality tab retains the source page for download cookies and request context', async () => {
  const background = fs.readFileSync(require.resolve('../firefox/background.js'), 'utf8');
  const start = background.indexOf('async function activeTab()');
  const end = background.indexOf('async function execute(', start);
  const source = { id: 7, url: 'https://x.com/user/status/123' };
  const context = vm.createContext({ browser: {
    tabs: { query: async () => [{ url: 'moz-extension://fixture/download-options.html?url=video', openerTabId: 7 }], get: async id => { assert.equal(id, 7); return source; } },
    runtime: { getURL: file => 'moz-extension://fixture/' + file }
  } });
  vm.runInContext(background.slice(start, end), context);
  assert.equal((await context.activeTab()).id, source.id);
});
