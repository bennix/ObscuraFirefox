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

function translationFixture(replies) {
  let calls = 0;
  const reading = new Reading({ directory: os.tmpdir(), settings: {
    read: async () => ({ model: 'fixture', baseURL: 'https://fixture.invalid', translationLanguage: '中文' }),
    key: async () => 'fixture-key'
  }, fetcher: async () => {
    const content = replies[Math.min(calls++, replies.length - 1)];
    return Response.json({ choices: [{ message: { content } }] });
  } });
  return { reading, calls: () => calls };
}
const translationInput = { segments: [{ id: 'a', text: 'Say "hello".' }, { id: 'b', text: 'Next line.' }] };
const validTranslation = JSON.stringify({ translations: [{ id: 'a', text: '说“你好”。' }, { id: 'b', text: '下一行。' }] });
test('translation regenerates malformed JSON without exposing partial output', async () => {
  const fixture = translationFixture(['{"translations":[{"id":"a","text":"say "hello""}]}', validTranslation]);
  const result = await fixture.reading.translate(translationInput);
  assert.equal(result.translations.length, 2);
  assert.equal(result.translations[0].text, '说“你好”。');
  assert.equal(fixture.calls(), 2);
});
test('translation retries null, missing and duplicate paragraph responses', async () => {
  for (const content of ['null', '{"translations":[]}', JSON.stringify({ translations: [{ id: 'a', text: 'one' }, { id: 'a', text: 'duplicate' }] })]) {
    const fixture = translationFixture([content, validTranslation]);
    assert.equal((await fixture.reading.translate(translationInput)).translations[1].id, 'b');
    assert.equal(fixture.calls(), 2);
  }
});
test('persistent malformed output stops at three responses with a friendly error', async () => {
  const fixture = translationFixture(['{"translations":']);
  await assert.rejects(fixture.reading.translate(translationInput), error => /自动重试/.test(error.message) && !/JSON at position|Unexpected/.test(error.message));
  assert.equal(fixture.calls(), 3);
});
test('translation accepts whitespace around fenced JSON and rejects duplicate input IDs', async () => {
  const fixture = translationFixture([' \n```json\n' + validTranslation + '\n```\n ']);
  assert.equal((await fixture.reading.translate(translationInput)).translations.length, 2);
  await assert.rejects(fixture.reading.translate({ segments: [{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }] }), /ID/);
  assert.equal(fixture.calls(), 1);
});
test('cancelled translation never sends a request', async () => {
  const fixture = translationFixture([validTranslation]);
  const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
  await assert.rejects(fixture.reading.translate(translationInput, controller.signal), /cancelled/);
  assert.equal(fixture.calls(), 0);
});
