const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const PDFLib = require('pdf-lib');
const executablePath = process.env.OBSCURA_PASTE_TEST_BROWSER;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=';

test('paste chooser converts, preserves originals, cancels and recovers from failures', { skip: !executablePath }, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<form><textarea aria-label="Message"></textarea><input type="file" accept=".pdf,image/*" multiple hidden></form>');
  await page.evaluate(() => {
    // Expose the closed shadow root only in this fixture for UI assertions.
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { return attach.call(this, { ...options, mode: 'open' }); };
    window.originals = [];
    document.querySelector('textarea').addEventListener('paste', async event => {
      window.originals.push({ trusted: event.isTrusted, text: event.clipboardData.getData('text/plain'), data: [...new Uint8Array(await event.clipboardData.files[0].arrayBuffer())] });
    });
    window.uploads = 0;
    document.querySelector('input').addEventListener('change', () => window.uploads++);
    window.browser = {
      runtime: { id: 'workspace@obscura.local', onMessage: { addListener(fn) { window.pasteHandler = fn; } }, sendMessage(message) {
        if (window.failConversion) return Promise.reject(new Error('测试转换失败'));
        return window.pasteHandler(message, { id: 'workspace@obscura.local', tab: { id: 1 }, url: window.testSite || 'https://gemini.google.com/', frameId: 0 });
      } },
      scripting: { executeScript: async ({ func, args }) => [{ result: func(...args) }] },
      obscuraNative: {
        preparePastedPDF: async (tabId, url, payload) => { if (window.pauseSave) await new Promise(resolve => { window.finishSave = resolve; }); window.savedPDF = JSON.parse(payload); return { name: window.savedPDF.name }; },
        revealPastedPDF: async () => { window.revealedPDF = true; }
      }
    };
    HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('Canvas blocked'); };
    CanvasRenderingContext2D.prototype.getImageData = () => { throw new Error('Canvas blocked'); };
  });
  await page.addScriptTag({ path: require.resolve('pdf-lib/dist/pdf-lib.min.js') });
  await page.addScriptTag({ path: require.resolve('../firefox/image-pdf.js') });
  await page.addScriptTag({ path: require.resolve('../firefox/image-paste-background.js') });
  await page.addScriptTag({ path: require.resolve('../firefox/image-paste.js') });
  const paste = async () => page.evaluate(data => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }));
    transfer.setData('text/plain', 'clipboard text');
    const editor = document.querySelector('textarea');
    editor.focus();
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true, composed: true }));
  }, png);

  await paste();
  assert.equal(await page.locator('dialog').count(), 1);
  assert.equal(await page.evaluate(() => originals.length), 0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await page.evaluate(() => uploads), 0);

  await paste();
  await page.getByRole('button', { name: '发送原图', exact: true }).click();
  await page.waitForFunction(() => originals.length === 1);
  const original = await page.evaluate(() => originals[0]);
  assert.deepEqual(Buffer.from(original.data), Buffer.from(png, 'base64'));
  assert.equal(original.text, 'clipboard text');

  await paste();
  await page.getByRole('button', { name: '转为 PDF', exact: true }).click();
  await page.waitForFunction(() => uploads === 1);
  assert.equal(await page.locator('dialog').count(), 0);
  const uploaded = await page.evaluate(async () => {
    const file = document.querySelector('input').files[0];
    return { type: file.type, name: file.name, bytes: [...new Uint8Array(await file.arrayBuffer())] };
  });
  assert.equal(uploaded.type, 'application/pdf');
  assert.equal(uploaded.name, 'clipboard.pdf');
  assert.equal((await PDFLib.PDFDocument.load(Buffer.from(uploaded.bytes))).getPageCount(), 1);
  assert.equal(await page.evaluate(() => originals.length), 1);

  await page.evaluate(() => { window.failConversion = true; });
  await paste();
  await page.getByRole('button', { name: '转为 PDF', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '测试转换失败' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => { window.failConversion = false; document.querySelector('input').remove(); });
  await paste();
  await page.getByRole('button', { name: '转为 PDF', exact: true }).click();
  await page.getByRole('button', { name: '打开 PDF 所在文件夹' }).waitFor();
  assert.equal(await page.locator('dialog').count(), 0);
  await page.getByRole('button', { name: '打开 PDF 所在文件夹' }).click();
  assert.equal(await page.evaluate(() => revealedPDF), true);
  await page.getByRole('button', { name: '取消待上传' }).click();
  assert.equal(await page.evaluate(() => !!globalThis.__obscuraPendingPDF), false);

  await page.evaluate(() => { window.pauseSave = true; });
  await paste();
  await page.getByRole('button', { name: '转为 PDF', exact: true }).click();
  await page.waitForFunction(() => typeof window.finishSave === 'function');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => { window.finishSave(); window.pauseSave = false; });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-obscura-pdf-upload'));
  assert.equal(await page.evaluate(() => !!globalThis.__obscuraPendingPDF), false);
  assert.equal(await page.getByRole('button', { name: '取消待上传' }).count(), 0);

  for (const site of ['https://gemini.google.com/', 'https://chatgpt.com/', 'https://claude.ai/']) {
    await page.evaluate(url => { window.testSite = url; }, site);
    await paste();
    await page.getByRole('button', { name: '转为 PDF', exact: true }).click();
    await page.getByRole('button', { name: '打开 PDF 所在文件夹' }).waitFor();
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'application/pdf';
      input.onchange = () => { window.dynamicPDF = input.files[0]; };
      // These sites can create their file input only after the upload menu is clicked.
      input.click();
    });
    assert.equal(await page.evaluate(() => dynamicPDF.type), 'application/pdf');
    assert.equal(await page.getByRole('button', { name: '取消待上传' }).count(), 0);
    assert.equal((await PDFLib.PDFDocument.load(Buffer.from(await page.evaluate(async () => [...new Uint8Array(await dynamicPDF.arrayBuffer())])))).getPageCount(), 1);
    assert.equal(await page.evaluate(() => !!globalThis.__obscuraPendingPDF), false);
  }
});
