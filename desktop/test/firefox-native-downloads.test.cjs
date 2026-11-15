const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
for (const platform of ['posix', 'win32']) test(platform + ': native media saver reports bytes, exposes final file, and rejects remote bridge', async () => {
  const paths = require('node:path')[platform];
  const folder = platform === 'win32' ? 'C:\\媒体 下载' : '/tmp/media';
  const finalPath = paths.join(folder, 'media-test', 'movie.mp4');
  const rows = [], progress = [], requests = [];
  let run;
  const jobs = [
    { id: 'media-test', status: 'Downloading', downloaded: 100, size: 400 },
    { id: 'media-test', status: 'Complete', downloaded: 400, size: 400, path: finalPath }
  ];
  const Downloads = { PUBLIC: 1, getList: async () => ({ add: async d => rows.push(d) }), createDownload: async data => ({ ...data, target: { path: data.target }, start() { run = this.saver.execute((...args) => progress.push(args)); return run; } }) };
  const context = {
    URL, console, PathUtils: { join: (...parts) => paths.join(...parts) }, Cu: { importGlobalProperties() {} }, Services: { prefs: { getBoolPref: () => true } },
    ChromeUtils: { importGlobalProperties() {}, importESModule(name) {
      if (name.includes('ExtensionCommon')) return { ExtensionCommon: { ExtensionAPI: class {} } };
      if (name.includes('ExtensionUtils')) return { ExtensionError: Error };
      if (name.includes('Downloads.sys')) return { Downloads };
      if (name.includes('DownloadCore')) return { DownloadSaver: class {} };
      if (name.includes('Timer.sys')) return { setTimeout: callback => setImmediate(callback) };
      throw new Error(name);
    } },
    fetch: async (_, options) => { requests.push(JSON.parse(options.body).action); return { ok: true, json: async () => ({ downloads: [jobs.shift()] }) }; }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../firefox/native-api.js'), 'utf8'), context);
  const api = new context.obscuraNative().getAPI({}).obscuraNative;
  const data = { job: { id: 'media-test', url: 'https://example.org/media.m3u8' }, folder, bridge: { origin: 'http://127.0.0.1:1234', token: 'test' } };
  await api.trackMediaDownload(JSON.stringify(data)); await run;
  assert.equal(rows.length, 1);
  assert.equal(progress[0][0], 100); assert.equal(progress[0][1], 400);
  assert.equal(rows[0].target.path, finalPath);
  assert.equal(rows[0].target.path.includes(platform === 'win32' ? '/' : '\\'), false);
  await rows[0].saver.cancel(); assert.equal(requests.at(-1), 'pause');
  await api.trackMediaDownload(JSON.stringify(data)); assert.equal(rows.length, 1);
  data.bridge.origin = 'https://example.org';
  await assert.rejects(api.trackMediaDownload(JSON.stringify(data)), /Invalid local bridge/);
});
