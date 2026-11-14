const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_FILE = 16 * 1024 * 1024;
const MAX_MESSAGE = 32 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

class Attachments {
  constructor(directory) { this.directory = path.join(directory, 'attachments'); }

  async add(input) {
    if (typeof input.data !== 'string' || input.data.length > MAX_FILE * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error('附件数据无效或超过 16 MB');
    const bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE) throw new Error('附件需要在 1 字节到 16 MB 之间');
    const name = path.basename(String(input.name || 'attachment')).slice(0, 200);
    const mime = String(input.mime || '');
    let kind = 'text';
    if (imageTypes.has(mime)) {
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216;
      const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
      if (!(mime === 'image/png' && png || mime === 'image/jpeg' && jpeg || mime === 'image/webp' && webp)) throw new Error('图片格式与文件内容不匹配');
      kind = 'image';
    } else if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('PDF 文件内容无效');
      kind = 'pdf';
    } else if (!(mime.startsWith('text/') || /\.(txt|md|csv|json|jsonl|xml|html?|css|js|ts|py|rs|yaml|yml|log|svg)$/i.test(name))) {
      throw new Error('当前支持 PNG、JPEG、WebP、文本文件和 PDF');
    }
    const metadata = { id: randomUUID(), name, mime: kind === 'pdf' ? 'application/pdf' : mime, kind, size: bytes.length };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(this.directory, metadata.id), bytes, { mode: 0o600 });
    await fs.writeFile(path.join(this.directory, metadata.id + '.json'), JSON.stringify(metadata), { mode: 0o600 });
    return metadata;
  }

  async get(id, data = false) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('无效附件');
    const metadata = JSON.parse(await fs.readFile(path.join(this.directory, id + '.json'), 'utf8'));
    if (data) metadata.data = (await fs.readFile(path.join(this.directory, id))).toString('base64');
    return metadata;
  }

  async parts(references) {
    if (!Array.isArray(references) || references.length > 10) throw new Error('每条消息最多添加 10 个附件');
    const parts = [];
    let total = 0;
    for (const reference of references) {
      const attachment = await this.get(reference.id);
      total += attachment.size;
      if (total > MAX_MESSAGE) throw new Error('每条消息的附件总量不能超过 32 MB');
      const bytes = await fs.readFile(path.join(this.directory, attachment.id));
      if (attachment.kind === 'image') {
        parts.push({ type: 'text', text: `附件图片 ${attachment.name}（附件 ID：${attachment.id}）` });
        parts.push({ type: 'image_url', image_url: { url: `data:${attachment.mime};base64,${bytes.toString('base64')}` } });
      } else {
        let text;
        if (attachment.kind === 'pdf') {
          const { extractText } = await import('unpdf');
          const result = await extractText(new Uint8Array(bytes), { mergePages: true });
          text = result.text;
          if (!text.trim()) throw new Error(`PDF“${attachment.name}”没有可提取的文字，请粘贴页面截图`);
        } else text = bytes.toString('utf8');
        const truncated = text.length > 200000;
        parts.push({ type: 'text', text: `附件 ${attachment.name}（附件 ID：${attachment.id}）\n${text.slice(0, 200000)}${truncated ? '\n[内容过长，已截取前 200000 个字符]' : ''}` });
      }
    }
    return parts;
  }

  async apiMessages(messages) {
    return Promise.all(messages.map(async message => {
      const { attachments, ...apiMessage } = message;
      if (message.role === 'user' && attachments?.length) {
        apiMessage.content = [{ type: 'text', text: typeof message.content === 'string' ? message.content : '请分析附件' }, ...await this.parts(attachments)];
      }
      return apiMessage;
    }));
  }

  async clear() { await fs.rm(this.directory, { recursive: true, force: true }); }
}

module.exports = { Attachments };
