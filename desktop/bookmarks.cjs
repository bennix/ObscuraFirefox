const fs = require('node:fs/promises');
const path = require('node:path');

const limit = 500;

function normalizeURL(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只能收藏 http 或 https 地址');
  url.hash = '';
  return url.href;
}

function parseBookmarkFile(html) {
  const items = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html)))) {
    const href = (match[1].match(/\bhref\s*=\s*"([^"]+)"/i) || match[1].match(/\bhref\s*=\s*'([^']+)'/i) || [])[1];
    if (!href) continue;
    try {
      const url = normalizeURL(href);
      const title = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim().slice(0, 200) || url;
      if (!items.some(item => item.url === url)) items.push({ url, title });
    } catch {}
    if (items.length >= limit) break;
  }
  return items;
}

function bookmarkFile(items) {
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = items.map(item => `<DT><A HREF="${escape(item.url)}">${escape(item.title || item.url)}</A>`).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${rows}\n</DL><p>\n`;
}

class Bookmarks {
  constructor(file) { this.file = file; this.items = []; }

  async load() {
    try { this.items = JSON.parse(await fs.readFile(this.file, 'utf8')).filter(item => item?.url).slice(0, limit); }
    catch { this.items = []; }
    return this.items;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.items, null, 2), { mode: 0o600 });
  }

  has(url) {
    try { return this.items.some(item => item.url === normalizeURL(url)); }
    catch { return false; }
  }

  async toggle(url, title) {
    const href = normalizeURL(url);
    const existing = this.items.findIndex(item => item.url === href);
    if (existing >= 0) this.items.splice(existing, 1);
    else {
      if (this.items.length >= limit) throw new Error('收藏最多 500 条');
      this.items.unshift({ url: href, title: String(title || href).trim().slice(0, 200) || href, added: new Date().toISOString() });
    }
    await this.save();
    return this.items;
  }

  async remove(url) {
    const href = normalizeURL(url);
    this.items = this.items.filter(item => item.url !== href);
    await this.save();
    return this.items;
  }

  async importFile(html) {
    for (const item of parseBookmarkFile(html).reverse()) {
      if (this.items.some(saved => saved.url === item.url)) continue;
      if (this.items.length >= limit) break;
      this.items.unshift({ ...item, added: new Date().toISOString() });
    }
    await this.save();
    return this.items;
  }
}

module.exports = { Bookmarks, parseBookmarkFile, bookmarkFile, normalizeURL };
