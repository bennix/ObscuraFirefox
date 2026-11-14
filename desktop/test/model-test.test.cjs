const { test } = require('node:test');
const assert = require('node:assert/strict');
const { probeModel } = require('../model-test.cjs');

test('model probe reports a short reply and a provider error', async () => {
  const ok = await probeModel({
    key: 'secret', model: 'demo/model',
    fetcher: async (url, options) => {
      assert.equal(url, 'https://zenmux.ai/api/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer secret');
      assert.equal(JSON.parse(options.body).model, 'demo/model');
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'demo/model', choices: [{ message: { content: 'ok' } }] }) };
    }
  });
  assert.deepEqual(ok, { ok: true, status: 200, model: 'demo/model', reply: 'ok' });
  const failed = await probeModel({
    key: 'secret', model: 'missing/model',
    fetcher: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'invalid key' } }) })
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 401);
  assert.equal(failed.message, 'invalid key');
  await assert.rejects(probeModel({ key: 'secret', model: 'demo/model', proxy: 'socks5h://127.0.0.1:1080' }), /手动 HTTP 代理/);
});
