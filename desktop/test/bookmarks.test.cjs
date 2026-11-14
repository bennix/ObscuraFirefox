const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Bookmarks, parseBookmarkFile, bookmarkFile } = require('../bookmarks.cjs');

test('bookmarks toggle, visit identity, and Netscape import', async () => {
  const file = path.join(os.tmpdir(), `obscura-bookmarks-${Date.now()}.json`);
  const bookmarks = new Bookmarks(file);
  await bookmarks.load();
  await bookmarks.toggle('https://example.com/path#section', 'Example');
  assert.equal(bookmarks.has('https://example.com/path'), true);
  await bookmarks.toggle('https://example.com/path', 'Example');
  assert.equal(bookmarks.items.length, 0);
  const imported = parseBookmarkFile(bookmarkFile([{ url: 'https://example.com/', title: 'A & B' }]) + '\n<DT><A HREF="https://news.example/item">News</A>');
  assert.equal(imported[0].title, 'A & B');
  await bookmarks.importFile(bookmarkFile(imported));
  assert.equal(bookmarks.items.length, 2);
  await fs.rm(file, { force: true });
});
