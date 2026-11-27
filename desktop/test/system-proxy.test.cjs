const test = require('node:test');
const assert = require('node:assert/strict');
const { readNativeSystemProxy } = require('../system-proxy.cjs');

test('Linux without GNOME proxy schemas remains usable', async () => {
  const result = await readNativeSystemProxy({ platform: 'linux', run: async () => {
    throw Object.assign(new Error('gsettings failed'), { code: 1, stderr: 'No such schema “org.gnome.system.proxy”' });
  } });
  assert.equal(result, '<dictionary> {\n\n}');
});

test('Linux does not silently ignore an unreadable configured proxy', async () => {
  const error = Object.assign(new Error('access denied'), { code: 1, stderr: 'Permission denied' });
  await assert.rejects(readNativeSystemProxy({ platform: 'linux', run: async () => { throw error; } }), /access denied/);
});

test('macOS can omit disabled proxy flags on a direct network', async () => {
  const { parseSystemProxy } = require('../proxy.cjs');
  const system = await readNativeSystemProxy({ platform: 'darwin', run: async () => ({ stdout: '<dictionary> {\n  ExcludeSimpleHostnames : 0\n}\n' }) });
  assert.equal(parseSystemProxy(system, 'https://example.org'), 'direct');
});
