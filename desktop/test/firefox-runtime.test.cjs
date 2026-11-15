const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const backendRoot = process.env.OBSCURA_TEST_BACKEND || path.join(__dirname, '..');
const { start } = require(path.join(backendRoot, 'firefox/start.cjs'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = result => JSON.parse(result.content[0].text);

test('source-built Firefox supports native tabs, AI actions, uploads, media detection and WebRTC protection', { skip: !process.env.OBSCURA_FIREFOX_BIN, timeout: 150000 }, async t => {
  for (const name of ['MOZ_DISABLE_CONTENT_SANDBOX', 'MOZ_DISABLE_GMP_SANDBOX', 'MOZ_DISABLE_RDD_SANDBOX']) {
    assert.equal(process.env[name], undefined, `${name} must not be set during release validation`);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'Obscura 中文 runtime '));
  const nativeManifest = (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts/ai.obscura.workspace.json') : process.platform === 'win32' ? path.join(directory, 'NativeMessagingHosts/ai.obscura.workspace.json') : path.join(os.homedir(), '.mozilla/native-messaging-hosts/ai.obscura.workspace.json'));
  let previousManifest;
  try { previousManifest = await fs.readFile(nativeManifest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let app;
  const hls = path.join(directory, 'hls'); await fs.mkdir(hls);
  execFileSync(path.join(backendRoot, 'runtime/media', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), ['-y','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','4','-c:v','libx264','-force_key_frames','expr:gte(t,n_forced*1)','-hls_time','1','-hls_playlist_type','vod','-hls_segment_filename',path.join(hls,'part%03d.ts'),path.join(hls,'test.m3u8')], { stdio:'ignore' });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/hls/')) { const file = path.join(hls, path.basename(req.url)); res.setHeader('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'); const bytes = require('node:fs').readFileSync(file); if (file.endsWith('.ts')) setTimeout(() => res.end(bytes), 1500); else res.end(bytes); return; }
    if (req.url === '/frame') { res.setHeader('Content-Type', 'text/html'); res.end(`<script>parent.postMessage({probe:'cross',rtc:typeof RTCPeerConnection},'*')</script>`); return; }
    if (req.url === '/media.m3u8') { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Obscura Firefox fixture</title><h1>Browser fixture</h1><form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'"><input id="name"><button id="submit">Submit</button></form><input id="file" type="file" onchange="document.body.dataset.file=this.files[0].name"><button id="click" onclick="document.body.dataset.clicked='yes'">Click</button><p>Fixture text for snapshots.</p><script>addEventListener('message',e=>{if(['cross','opaque'].includes(e.data?.probe))document.body.dataset[e.data.probe]=e.data.rtc});fetch('/media.m3u8');fetch('/hls/test.m3u8')</script><iframe src="http://localhost:${server.address().port}/frame"></iframe><iframe sandbox="allow-scripts" srcdoc="&lt;script>parent.postMessage({probe:'opaque',rtc:typeof RTCPeerConnection},'*')&lt;/script>"></iframe>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app?.close(); await new Promise(resolve => server.close(resolve));
    if (previousManifest) await fs.writeFile(nativeManifest, previousManifest, { mode: 0o600 });
    else await fs.rm(nativeManifest, { force: true });
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  app = await start({ binary: process.env.OBSCURA_FIREFOX_BIN, directory, testing: true, url, settings: { read: async () => ({ searchEngine: 'google', theme: 'dark', proxy: { mode: 'system' } }) } });
  const deadline = Date.now() + 60000;
  while (!app.tools.browserClient.open && Date.now() < deadline) await pause(250);
  assert.equal(app.tools.browserClient.open, true, 'Built-in workspace must connect without debugging flags');
  await app.tools.call('browser_navigate', { url });
  app.tools.currentPage = await app.tools.page();
  const snapshot = value(await app.tools.call('browser_snapshot'));
  assert.equal(snapshot.title, 'Obscura Firefox fixture');
  await app.tools.call('browser_fill', { selector: '#name', value: 'Obscura' });
  assert.ok(value(await app.tools.call('browser_snapshot')).controls.some(control => control.value === 'Obscura'));
  await t.test('HLS completion appears in Firefox native downloads with the merged file', async () => {
    const media = value(await app.tools.call('browser_media')).media;
    const detected = media.find(item => item.kind === 'HLS' && item.url === url+'hls/test.m3u8');
    assert.ok(detected, 'HLS URL must be sniffed before downloading');
    const response = await fetch(app.origin + '/downloads', { method:'POST', headers:{'Content-Type':'application/json','X-Obscura-Token':app.token}, body:JSON.stringify({action:'add',args:{url:detected.url,media:true,file_name:'媒体 合并测试.mp4'}}) });
    assert.equal(response.ok,true, await response.text());
    let found, observedActive = false;
    const end=Date.now()+45000;
    while(Date.now()<end) {
      const rows=await app.tools.request('browser_download_status');
      observedActive ||= rows.some(row=>row.url===detected.url && row.state==='in_progress');
      found=rows.find(row=>row.url===url+'hls/test.m3u8' && row.state==='complete');
      if(found)break;
      await pause(500);
    }
    assert.ok(found,'Completed HLS must be present in native downloads');
    assert.ok(observedActive, 'Firefox must show the active download before completion');
    assert.match(found.filename, /媒体 合并测试/);
    assert.ok((await fs.stat(found.filename)).size>0);
    const decoded = execFileSync(path.join(backendRoot, 'runtime/media', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), ['-v','error','-i',found.filename,'-map','0:v:0','-f','null','-progress','pipe:1','-'], { encoding:'utf8', windowsHide:true });
    const times = [...decoded.matchAll(/^out_time_us=(\d+)$/gm)].map(match => Number(match[1]));
    assert.ok(Math.max(...times) >= 3500000, 'Merged video must decode all segments');
    await fs.rm(path.dirname(found.filename), { recursive:true, force:true });
  });
  await t.test('native Enter produces a trusted event and submits the form', async () => {
    await app.tools.call('browser_evaluate', { expression: `(() => { window.__trustedEnter=false; addEventListener('keydown', e => { if(e.key==='Enter' && e.isTrusted) window.__trustedEnter=true; }); })()` });
    await app.tools.call('browser_press_key', { key: 'Enter' });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (value(await app.tools.call('browser_evaluate', { expression: 'document.body.dataset.submitted' })) === 'yes') break;
      await pause(50);
    }
    assert.deepEqual(value(await app.tools.call('browser_evaluate', { expression: '({submitted:document.body.dataset.submitted,trusted:window.__trustedEnter})' })), { submitted: 'yes', trusted: true });
  });
  await t.test('click, upload, RTC, HLS, screenshot and tab lifecycle', async () => {
  await app.tools.call('browser_fill', { selector: '#name', value: 'Obscura' });
  await app.tools.call('browser_click', { selector: '#click' });
  const attachment = await app.tools.attachments.add({ name: 'fixture.txt', mime: 'text/plain', data: Buffer.from('upload fixture').toString('base64') });
  await app.tools.call('browser_upload', { selector: '#file', attachmentId: attachment.id });
  const state = value(await app.tools.call('browser_evaluate', { expression: `({ name:document.querySelector('#name').value, clicked:document.body.dataset.clicked, file:document.body.dataset.file, rtc:typeof RTCPeerConnection, webdriver:navigator.webdriver })` }));
  assert.deepEqual(state, { name: 'Obscura', clicked: 'yes', file: 'fixture.txt', rtc: 'undefined', webdriver: false });
  const frameDeadline = Date.now() + 3000;
  let frames;
  do {
    frames = value(await app.tools.call('browser_evaluate', { expression: '({cross:document.body.dataset.cross,opaque:document.body.dataset.opaque})' }));
    if (frames.cross && frames.opaque) break;
    await pause(50);
  } while (Date.now() < frameDeadline);
  assert.deepEqual(frames, { cross: 'undefined', opaque: 'undefined' });
  const media = value(await app.tools.call('browser_media')).media;
  assert.ok(media.some(item => item.kind === 'HLS' && item.url.endsWith('/hls/test.m3u8')));
  const shot = await app.tools.call('browser_screenshot');
  const bytes = Buffer.from(shot.content[0].data, 'base64');
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.ok(bytes.length > 1000);
  const original = app.tools.currentPage.tabId;
  const added = value(await app.tools.call('browser_new_tab', { url }));
  assert.notEqual(added.id, original);
  await app.tools.call('browser_select_tab', { tabId: original });
  await app.tools.call('browser_close_tab', { tabId: added.id });
  const tabs = value(await app.tools.call('browser_tabs'));
  assert.ok(tabs.some(tab => tab.id === original));
  assert.ok(!tabs.some(tab => tab.id === added.id));
  });
});
