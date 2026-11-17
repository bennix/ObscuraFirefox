const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const PDFLib = require('pdf-lib');
const backend = process.env.OBSCURA_TEST_BACKEND || path.join(__dirname, '..');
const { start } = require(path.join(backend, 'firefox/start.cjs'));

test('Firefox pastes a local PDF with Canvas protection enabled', { skip: !process.env.OBSCURA_FIREFOX_BIN, timeout: 90000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-paste-native-'));
  const manifest = path.join(os.homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts/ai.obscura.workspace.json');
  const previous = await fs.readFile(manifest).catch(() => null);
  let app, savedDirectory;
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Paste fixture</title><h1>图片粘贴验收</h1><form><textarea aria-label="Message"></textarea><input type="file" accept="application/pdf" hidden onchange="document.body.dataset.uploaded=this.files[0].type"></form><script>document.querySelector("textarea").addEventListener("paste",event=>{document.body.dataset.pastes=String(event.clipboardData.files.length);const file=event.clipboardData.files[0];if(!file)return;const reader=new FileReader();reader.onload=()=>document.body.dataset.original=reader.result.split(",")[1];reader.readAsDataURL(file)});</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app?.close();
    if (savedDirectory && path.basename(path.dirname(savedDirectory)) === 'Obscura PDFs') await fs.rm(savedDirectory, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
    if (previous) await fs.writeFile(manifest, previous);
    else await fs.rm(manifest, { force: true });
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const options = { directory, testing: true, url, settings: { read: async () => ({ searchEngine: 'google', theme: 'light', proxy: { mode: 'system' } }) } };
  if (process.env.OBSCURA_PREVIOUS_FIREFOX_BIN) {
    app = await start({ ...options, binary: process.env.OBSCURA_PREVIOUS_FIREFOX_BIN });
    const previousDeadline = Date.now() + 45000;
    while (!app.tools.browserClient.open && Date.now() < previousDeadline) await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(app.tools.browserClient.open, 'Previous browser must initialize the upgrade fixture');
    await app.close();
  }
  app = await start({ ...options, binary: process.env.OBSCURA_FIREFOX_BIN });
  const deadline = Date.now() + 45000;
  while (!app.tools.browserClient.open && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(app.tools.browserClient.open, 'Built-in extension must connect');
  await app.tools.call('browser_navigate', { url });
  const evaluate = expression => app.tools.request('browser_evaluate', { expression });
  assert.equal(await evaluate('browser.runtime.getManifest().version'), require('../firefox/manifest.json').version, 'Existing profiles must load the new workspace version');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=';
  await evaluate(`(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) { return attach.call(this, { ...options, mode: 'open' }); };
    globalThis.pasteImage = () => {
    const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true, composed: true });
    event.clipboardData.items.add(new File([Uint8Array.from(atob('${png}'), c => c.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }));
    const editor = document.querySelector('textarea'); editor.focus();
    editor.dispatchEvent(event);
    };
    globalThis.pasteImage();
    return true;
  })()`);
  assert.equal(await evaluate(`(() => { const host = [...document.querySelectorAll('div')].find(el => el.shadowRoot?.querySelector('dialog')); return !!host; })()`), true);
  if (process.env.OBSCURA_PASTE_SCREENSHOT) {
    const screenshot = await app.tools.call('browser_screenshot');
    await fs.writeFile(process.env.OBSCURA_PASTE_SCREENSHOT, Buffer.from(screenshot.content[0].data, 'base64'));
  }
  await evaluate(`(() => { const host = [...document.querySelectorAll('div')].find(el => el.shadowRoot?.querySelector('dialog')); host.shadowRoot.querySelector('[data-action="original"]').click(); return true; })()`);
  for (let i = 0; i < 30; i++) {
    if (await evaluate(`document.body.dataset.original || ''`)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await evaluate(`document.body.dataset.original || ''`), png, 'Original image bytes must reach the website unchanged');
  await evaluate('globalThis.pasteImage(); true;');
  await evaluate(`(() => { const host = [...document.querySelectorAll('div')].find(el => el.shadowRoot?.querySelector('dialog')); host.shadowRoot.querySelector('[data-action="pdf"]').click(); return true; })()`);
  let uploaded;
  for (let i = 0; i < 50; i++) {
    uploaded = await evaluate(`document.body.dataset.uploaded || ''`);
    if (uploaded) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!uploaded) console.log(await evaluate(`(() => { const host = [...document.querySelectorAll('div')].find(el => el.shadowRoot?.querySelector('dialog')); return host?.shadowRoot.textContent; })()`));
  assert.equal(uploaded, 'application/pdf', 'Website must receive the PDF file');
  const data = await evaluate(`(async () => { const file = document.querySelector('input').files[0]; return [...new Uint8Array(await file.arrayBuffer())]; })()`);
  assert.equal((await PDFLib.PDFDocument.load(Buffer.from(data))).getPageCount(), 1);
  await evaluate(`document.querySelector('input').remove(); globalThis.pasteImage(); true;`);
  await evaluate(`(() => { const host = [...document.querySelectorAll('div')].find(el => el.shadowRoot?.querySelector('dialog')); host.shadowRoot.querySelector('[data-action="pdf"]').click(); return true; })()`);
  let notice;
  for (let i = 0; i < 50; i++) {
    notice = await evaluate(`(() => { const host = [...document.querySelectorAll('div')].find(el => el.shadowRoot?.querySelector('[data-action="reveal"]')); return host?.shadowRoot.textContent || ''; })()`);
    if (notice) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!notice) console.log(await evaluate(`(() => { const host = [...document.querySelectorAll('div')].find(el => el.shadowRoot?.querySelector('dialog')); return host?.shadowRoot.textContent; })()`));
  assert.match(notice, /上传文件/);
  if (process.env.OBSCURA_PASTE_NOTICE_SCREENSHOT) {
    const screenshot = await app.tools.call('browser_screenshot');
    await fs.writeFile(process.env.OBSCURA_PASTE_NOTICE_SCREENSHOT, Buffer.from(screenshot.content[0].data, 'base64'));
  }
  await evaluate(`(() => {
    const button = document.createElement('button'); button.id = 'dynamic-upload'; button.textContent = '上传文件';
    button.setAttribute('onclick', 'const input=document.createElement("input");input.type="file";input.accept="application/pdf";input.onchange=()=>document.body.dataset.dynamic=input.files[0].type;input.click();');
    document.body.append(button); return true;
  })()`);
  await app.tools.call('browser_click', { selector: '#dynamic-upload' });
  assert.equal(await evaluate('document.body.dataset.dynamic'), 'application/pdf', 'Lazy upload inputs must receive the prepared PDF');
  const webp = await evaluate(`browser.runtime.sendMessage({ type: 'obscura-image-pdf', files: [{ name: 'image.webp', mime: 'image/webp', data: 'UklGRjoAAABXRUJQVlA4IC4AAAAQAgCdASoCAAEAAUAmJaACdLoB+AH4AAPIAP7tBy/9WfTQi/vX//Rg3+UXyxgA' }] })`);
  const webpPDF = await PDFLib.PDFDocument.load(Buffer.from(webp.data, 'base64'));
  assert.deepEqual(webpPDF.getPage(0).getSize(), { width: 2, height: 1 });
  const images = webpPDF.getPage(0).node.Resources().lookup(PDFLib.PDFName.of('XObject'));
  const pixels = require('node:zlib').inflateSync(images.lookup(images.keys()[0]).getContents());
  assert.ok(pixels[0] >= 20 && pixels[0] <= 40 && pixels[1] >= 110 && pixels[1] <= 130 && pixels[2] >= 200 && pixels[2] <= 220, 'Extension conversion must preserve image colors under fingerprint protection');
  const prefs = await fs.readFile(path.join(directory, 'profile/user.js'), 'utf8');
  assert.match(prefs, /user_pref\("privacy.resistFingerprinting", true\)/);
  assert.match(prefs, /user_pref\("media.peerconnection.enabled", false\)/);
  await app.close(); app = null;
  const { execFileSync } = require('node:child_process');
  savedDirectory = execFileSync('python3', ['-c', "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute(\"SELECT prefs.value FROM prefs JOIN settings ON prefs.settingID=settings.id WHERE settings.name='browser.upload.lastDir' ORDER BY prefs.id DESC LIMIT 1\").fetchone()[0])", path.join(directory, 'profile/content-prefs.sqlite')], { encoding: 'utf8' }).trim();
  assert.equal(path.basename(path.dirname(savedDirectory)), 'Obscura PDFs');
  assert.deepEqual(await fs.readdir(savedDirectory), ['clipboard.pdf']);
  assert.equal((await fs.readFile(path.join(savedDirectory, 'clipboard.pdf'))).subarray(0, 5).toString(), '%PDF-');

});
