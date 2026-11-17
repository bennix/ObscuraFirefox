const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(privateBrowsing = false) {
  const writes = [], prefs = [], revealed = [];
  const loadContext = { usePrivateBrowsing: privateBrowsing };
  const browser = { currentURI: { scheme: 'https', spec: 'https://chatgpt.com/c/example' } };
  const nativeTab = { linkedBrowser: browser, documentGlobal: { docShell: { QueryInterface: () => loadContext } } };
  const sandbox = {
    Uint8Array, atob, URL,
    Services: { prefs: { getBoolPref: () => true }, uuid: { generateUUID: () => '{test-pdf-folder}' } },
    PathUtils: { join: path.join },
    IOUtils: { makeDirectory: async () => {}, write: async (file, bytes) => writes.push({ file, bytes: Buffer.from(bytes) }) },
    Cu: { importGlobalProperties() {} }, Ci: { nsILoadContext: {}, nsIContentPrefService2: {}, nsIFile: {} },
    Cc: {
      '@mozilla.org/content-pref/service;1': { getService: () => ({ set(...args) { prefs.push(args.slice(0, 4)); args[4].handleCompletion(); } }) },
      '@mozilla.org/file/local;1': { createInstance: () => ({ initWithPath(file) { revealed.push(file); }, reveal() {} }) }
    },
    ChromeUtils: { importESModule: () => ({ ExtensionCommon: { ExtensionAPI: class {} }, ExtensionError: Error, Downloads: { getPreferredDownloadsDirectory: async () => '/downloads' } }) }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../firefox/native-api.js'), 'utf8'), sandbox);
  const api = new sandbox.obscuraNative().getAPI({ extension: { tabManager: { get: () => ({ nativeTab }) } } }).obscuraNative;
  return { api, writes, prefs, revealed, loadContext, browser };
}

for (const privateBrowsing of [false, true]) test(`generated PDF is saved and the site file picker opens its directory, private=${privateBrowsing}`, async () => {
  const { api, writes, prefs, revealed, loadContext } = fixture(privateBrowsing);
  const file = { name: '../clipboard.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.7\nfixture').toString('base64') };
  const result = await api.preparePastedPDF(1, 'https://chatgpt.com/', JSON.stringify(file));
  assert.equal(result.name, '.._clipboard.pdf');
  assert.deepEqual(writes[0].bytes, Buffer.from('%PDF-1.7\nfixture'));
  assert.equal(path.dirname(writes[0].file), '/downloads/Obscura PDFs/test-pdf-folder');
  assert.deepEqual(prefs[0], ['https://chatgpt.com/c/example', 'browser.upload.lastDir', path.dirname(writes[0].file), loadContext]);
  await api.revealPastedPDF(1, 'https://chatgpt.com/');
  assert.deepEqual(revealed, [writes[0].file]);
});

test('PDF location rejects navigation changes and invalid file contents', async () => {
  const { api, writes } = fixture();
  await assert.rejects(api.preparePastedPDF(1, 'https://claude.ai/', '{}'), /网页已切换/);
  await assert.rejects(api.preparePastedPDF(1, 'https://chatgpt.com/', JSON.stringify({ mime: 'application/pdf', data: btoa('broken') })), /数据无效/);
  await assert.rejects(api.revealPastedPDF(1, 'https://chatgpt.com/'), /请先/);
  assert.equal(writes.length, 0);
});
