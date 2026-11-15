const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const backendRoot = process.env.OBSCURA_TEST_BACKEND || path.join(__dirname, '..');
const { Downloads } = require(path.join(backendRoot, 'downloads.cjs'));
const { resolvePacRoute } = require(path.join(backendRoot, 'proxy.cjs'));

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(check, seconds = 30) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error('Download verification timed out');
}

test('embedded MDM file download and selected HLS fragments pause, resume and merge', { timeout: 90000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-downloads-'));
  const hls = path.join(directory, 'hls'); await fs.mkdir(hls);
  const ffmpeg = path.join(backendRoot, 'runtime/media/ffmpeg');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '8', '-c:v', 'libx264', '-c:a', 'aac', '-force_key_frames', 'expr:gte(t,n_forced*1)', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(hls, 'segment%03d.ts'), path.join(hls, 'index.m3u8')], { stdio: 'ignore' });
  await fs.writeFile(path.join(hls, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180\nindex.m3u8\n');
  const file = Buffer.alloc(4 * 1024 * 1024, 53);
  const segmentRequests = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/file.bin') {
      const match = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      const start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : file.length - 1;
      res.writeHead(match ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}) });
      if (req.method === 'HEAD') { res.end(); return; }
      for (let offset = start; offset <= end && !res.destroyed; offset += 16384) {
        res.write(file.subarray(offset, Math.min(end + 1, offset + 16384))); await pause(8);
      }
      res.end(); return;
    }
    const name = path.basename(new URL(req.url, 'http://local').pathname);
    try {
      const data = await fs.readFile(path.join(hls, name));
      res.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      if (name.endsWith('.ts')) { segmentRequests.add(name); await pause(300); }
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = { directory, output: path.join(directory, 'output'), browserTools: {}, transport: { resolve: async () => '' } };
  let manager = new Downloads(options);
  try {
    const task = await manager.add({ url: origin + '/file.bin' });
    assert.match(task.id, /^mdm-/);
    const completed = await waitFor(async () => (await manager.list()).downloads.find(job => job.id === task.id && job.status === 'Complete'));
    const actual = await fs.readFile(completed.path);
    assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(file).digest('hex'));
    const info = await manager.inspect(origin + '/master.m3u8');
    assert.ok(info.formats.length >= 1);
    let media = await manager.add({ url: origin + '/master.m3u8', media: true, format: info.formats[0].id });
    const trace = [];
    for (const channel of ['stdout', 'stderr']) manager.children.get(media.id)[channel].on('data', chunk => { if (trace.length < 8) trace.push(channel + ':' + chunk.toString()); });
    await manager.act('pause', [media.id]);
    assert.equal(media.status, 'Stopped');
    await pause(300);
    assert.equal(media.status, 'Stopped');
    await manager.act('start', [media.id]);
    await waitFor(() => {
      if (media.status === 'Complete' && !media.downloaded) throw new Error('Missing progress events: ' + trace.join('\n'));
      return media.downloaded > 0 || media.status === 'Error';
    });
    assert.notEqual(media.status, 'Error', media.error);
    assert.equal(media.status, 'Downloading', 'restart test interrupts an active transfer');
    await manager.close();
    manager = new Downloads(options);
    const recovered = await manager.list();
    media = manager.jobs.find(job => job.id === media.id);
    assert.ok(media);
    assert.ok(recovered.downloads.some(job => job.id === media.id));
    if (media.status !== 'Complete') {
      assert.equal(media.status, 'Stopped');
      await manager.act('start', [media.id]);
    }
    await waitFor(() => {
      if (media.status === 'Error') throw new Error(media.error);
      return media.status === 'Complete';
    });
    assert.ok(segmentRequests.size >= 3);
    assert.ok((await fs.stat(media.path)).size > 1000);
    execFileSync(ffmpeg, ['-v', 'error', '-i', media.path, '-f', 'null', '-'], { stdio: 'pipe' });
    await manager.act('remove', [media.id]);
    assert.ok((await fs.stat(media.path)).size > 1000, 'removing a record keeps its file');
    await manager.close();
  } finally {
    await manager.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('HLS resolves system PAC routing without falling back from a selected proxy', async () => {
  assert.equal(await resolvePacRoute('function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:7890; DIRECT"; }', 'https://media.example/master.m3u8'), 'http://127.0.0.1:7890');
});


test('media preparation is not exposed as a paused native download', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = Object.create(Downloads.prototype);
  manager.jobs = [];
  manager.save = async () => {};
  manager.runMedia = async job => { await gate; job.status = 'Downloading'; };
  const pending = manager.addMedia({ url: 'https://example.org/test.m3u8' });
  assert.deepEqual(manager.jobs, []);
  release();
  const job = await pending;
  assert.equal(manager.jobs[0], job);
  assert.equal(job.status, 'Downloading');
});
