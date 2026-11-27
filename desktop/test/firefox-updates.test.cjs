const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { checkUpdates, newerRelease } = require('../firefox/updates.cjs');

test('only a newer stable Firefox release qualifies', () => {
  for (const tag of ['v1.0.0', 'firefox-v0.3.15-beta', 'firefox-v0.3.13', 'firefox-v0.3.14']) {
    assert.equal(newerRelease(tag, '0.3.14'), false);
  }
  assert.equal(newerRelease('firefox-v0.10.0', '0.9.99'), true);
});

test('checks daily and opens each new release only once across restarts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-updates-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const tabs = [];
  const transport = { async fetch() {
    calls++;
    return { ok: true, json: async () => ({ tag_name: 'firefox-v99.0.0' }) };
  } };
  const tools = { browserClient: { open: true }, request: async (_, args) => tabs.push(args.url) };
  await checkUpdates(directory, transport, tools);
  await checkUpdates(directory, transport, tools);
  assert.equal(calls, 1);
  const file = path.join(directory, 'update-check.json');
  const state = JSON.parse(await fs.readFile(file));
  await fs.writeFile(file, JSON.stringify({ ...state, checked: 0 }));
  await checkUpdates(directory, transport, tools);
  assert.equal(calls, 2);
  assert.deepEqual(tabs, ['https://github.com/bennix/ObscuraFirefox/releases/tag/firefox-v99.0.0']);
});
