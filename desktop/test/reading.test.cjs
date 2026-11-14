const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Reading } = require('../reading.cjs');
const { destination, searchURL } = require('../navigation.cjs');

test('address bar supports sites, local ports and configurable search engines', () => {
  assert.equal(destination('example.com/path'), 'https://example.com/path');
  assert.equal(destination('localhost:8080/test'), 'http://localhost:8080/test');
  assert.equal(destination('127.0.0.1:9000'), 'http://127.0.0.1:9000/');
  assert.equal(destination('东京 天气'), 'https://www.google.com/search?q=%E4%B8%9C%E4%BA%AC%20%E5%A4%A9%E6%B0%94');
  assert.equal(destination('cats', 'bing'), 'https://www.bing.com/search?q=cats');
  assert.throws(() => destination('javascript:alert(1)'));
  assert.equal(searchURL('example.com', 'duckduckgo'), 'https://duckduckgo.com/?q=example.com');
  assert.equal(searchURL('Hello & world', 'bing'), 'https://www.bing.com/search?q=Hello%20%26%20world');
});

test('AI translation, contextual lookup and persistent paginated fuzzy dictionary', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-reading-'));
  const settings = { read: async () => ({ model: 'test-model', baseURL: 'https://zenmux.ai/api/v1', translationLanguage: '简体中文' }), key: async () => 'test-key' };
  let request;
  const reading = new Reading({ directory, settings, fetcher: async (url, options) => {
    request = JSON.parse(options.body);
    const input = JSON.parse(request.messages[1].content);
    const answer = input.segments ? { translations: input.segments.map(item => ({ id: item.id, text: '译文 ' + item.text })) } : { partOfSpeech: '名词', translation: '银行', explanation: '根据金融语境确定词义' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  try {
    const result = await reading.translate({ segments: [{ id: '1:0', text: 'Hello world.' }] });
    assert.equal(result.translations[0].original, 'Hello world.');
    assert.equal(request.model, 'test-model');
    const entry = await reading.lookup({ word: 'bank', context: 'She went to the bank.', sourceURL: 'https://example.com/' });
    assert.equal(entry.context, 'She went to the bank.');
    assert.equal(entry.partOfSpeech, '名词');
    await Promise.all(Array.from({ length: 25 }, (_, index) => reading.save({ ...entry, word: 'bank' + index })));
    const reopened = new Reading({ directory, settings });
    assert.equal((await reopened.list('', 2)).entries.length, 5);
    assert.equal((await reopened.list('BNK')).total, 25);
    assert.equal((await reopened.list('不存在')).total, 0);
    assert.equal((await reopened.list('', 999)).page, 2);
    await assert.rejects(reading.translate({ segments: [] }));
    await assert.rejects(reading.lookup({ word: '' }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
