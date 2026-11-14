const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Attachments } = require('../attachments.cjs');

function pdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${44 + text.length} >>\nstream\nBT /F1 14 Tf 30 250 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test('image, text and PDF attachments become model content without leaking local paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-attachments-'));
  const store = new Attachments(directory);
  try {
    const image = await store.add({ name: 'screen.png', mime: 'image/png', data: (await fs.readFile(require('node:path').join(__dirname, '../native/icon.png'))).toString('base64') });
    const text = await store.add({ name: 'notes.txt', mime: 'text/plain', data: Buffer.from('附件文字验证').toString('base64') });
    const document = await store.add({ name: 'report.pdf', mime: 'application/pdf', data: pdf('Attachment PDF verified').toString('base64') });
    const messages = await store.apiMessages([{ role: 'user', content: '分析附件', attachments: [image, text, document] }]);
    assert.equal(messages[0].attachments, undefined);
    assert.ok(messages[0].content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,')));
    assert.ok(messages[0].content.some(part => part.text?.includes('附件文字验证')));
    assert.ok(messages[0].content.some(part => part.text?.includes('Attachment PDF verified')));
    assert.doesNotMatch(JSON.stringify(messages), new RegExp(directory));
    await assert.rejects(store.get('../settings.json'), /无效附件/);
    await assert.rejects(store.add({ name: 'fake.png', mime: 'image/png', data: Buffer.from('not an image').toString('base64') }), /不匹配/);
    await store.clear();
    await assert.rejects(store.get(image.id));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
