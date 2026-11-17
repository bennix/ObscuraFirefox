const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const PDFLib = require('pdf-lib');
const sandbox = { Uint8Array, DataView, atob, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(require.resolve('pdf-lib/dist/pdf-lib.min.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(require.resolve('../firefox/image-pdf.js'), 'utf8'), sandbox);
const convert = sandbox.ObscuraImagePDF.convert;
const png = { name: 'clipboard.png', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=' };

test('PNG conversion embeds original pixels with no Canvas or network access', async () => {
  const result = await convert([png]);
  assert.equal(result.name, 'clipboard.pdf');
  assert.equal(result.mime, 'application/pdf');
  const pdf = await PDFLib.PDFDocument.load(Buffer.from(result.data, 'base64'));
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 1, height: 1 });
  assert.ok(pdf.getPage(0).node.Resources().lookup(PDFLib.PDFName.of('XObject')).keys().length > 0);
});

test('multiple pasted images become one PDF with one page per image', async () => {
  const result = await convert([png, png]);
  const pdf = await PDFLib.PDFDocument.load(Buffer.from(result.data, 'base64'));
  assert.equal(pdf.getPageCount(), 2);
});

test('rejects empty, unsupported, corrupt and oversized image batches', async () => {
  await assert.rejects(convert([]), /1 到 10/);
  await assert.rejects(convert(Array(11).fill(png)), /1 到 10/);
  await assert.rejects(convert([{ ...png, mime: 'text/html' }]), /格式/);
  await assert.rejects(convert([{ ...png, data: '' }]), /16 MB/);
  await assert.rejects(convert([{ ...png, data: btoa('broken') }]));
  const bytes = Buffer.from(png.data, 'base64');
  bytes.writeUInt32BE(40000001, 16);
  await assert.rejects(convert([{ ...png, data: bytes.toString('base64') }]), /尺寸过大/);
});

test('conversion messages require an extension content script on a web page', async () => {
  let listener;
  vm.runInNewContext(fs.readFileSync(require.resolve('../firefox/image-paste-background.js'), 'utf8'), {
    browser: { runtime: { id: 'workspace@obscura.local', onMessage: { addListener(fn) { listener = fn; } } } },
    ObscuraImagePDF: { convert: async files => files.length }
  });
  assert.equal(listener({ type: 'other' }, {}), undefined);
  await assert.rejects(listener({ type: 'obscura-image-pdf' }, { id: 'other', tab: {}, url: 'https://gemini.google.com/' }), /网页粘贴/);
  assert.equal(await listener({ type: 'obscura-image-pdf', files: [png] }, { id: 'workspace@obscura.local', tab: {}, url: 'https://claude.ai/' }), 1);
});

test('JPEG conversion preserves image dimensions without Canvas access', async () => {
  const result = await convert([{ name: 'image.jpg', mime: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDGooor7U+RP//Z' }]);
  const pdf = await PDFLib.PDFDocument.load(Buffer.from(result.data, 'base64'));
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 2, height: 1 });
});
