const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { CDP } = require('../cdp.cjs');
const { start } = require('../native/start.cjs');

const pause = delay => new Promise(resolve => setTimeout(resolve, delay));

test('standalone window keeps guest isolation, media, OAuth popups, attachments and themes', { timeout: 120000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-native-test-'));
  const videoPath = path.join(directory, 'fixture.mp4');
  require('node:child_process').execFileSync(path.resolve(__dirname, '../runtime/media/ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath]);
  const video = await fs.readFile(videoPath);
  let oauthRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/video.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length }); res.end(video); return; }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (req.url === '/frame') { res.end('<script>window.initialRTC=typeof RTCPeerConnection</script>Frame'); return; }
    if (req.url.split('?')[0] === '/oauth') {
      oauthRequests++;
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.end('<title>Google-style authorization</title><p id="opener">Authorization</p><script>const initialRTC=typeof RTCPeerConnection;let initialCanvasBlocked=false;try{document.createElement("canvas").toDataURL()}catch{initialCanvasBlocked=true}document.getElementById("opener").textContent=opener?"opener-preserved":"missing-opener";setTimeout(()=>{opener?.postMessage(initialRTC === "function" && window.name === "google-login" && new URLSearchParams(location.search).get("state") === "fixture+state" && location.hash === "#fixture-fragment" ? "oauth-success" : "privacy-failed","*");window.close()},1000)</script>'); return;
    }
    res.end(`<title>Native fixture</title><script>window.initialRTC=typeof RTCPeerConnection;addEventListener('message',event=>{if(event.data==='oauth-success')document.getElementById('result').textContent='oauth-success'})</script><input id="field"><button id="apply" onclick="document.getElementById('result').textContent=document.getElementById('field').value">Apply</button><p id="result">Ready</p><p id="reading-fixture" style="font-size:19px;color:rgb(12, 34, 56)">Hello world. This sentence gives context.</p><button id="login" onclick="window.open('http://localhost:${server.address().port}/oauth?state=fixture%2Bstate#fixture-fragment','google-login','width=500,height=600')">Google sign in</button><video id="video" controls muted src="/video.mp4"></video><button id="play" onclick="document.getElementById('video').play()">Play</button><iframe src="http://localhost:${server.address().port}/frame"></iframe><iframe srcdoc="<script>window.initialRTC=typeof RTCPeerConnection</script>"></iframe>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let application, browser;
  try {
    application = await start({ directory, stdio: 'ignore' });
    let bridge;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { bridge = JSON.parse(await fs.readFile(path.join(directory, 'launcher.json'), 'utf8')); break; } catch {}
      await pause(100);
    }
    assert.ok(bridge, 'local backend started');
    await pause(2500);
    const targets = await (await fetch('http://127.0.0.1:' + application.port + '/json/list')).json();
    const target = targets.find(page => page.url.includes('/native/index.html'));
    assert.ok(target, 'native application owns a window');
    browser = await CDP.connect(target.webSocketDebuggerUrl);
    const root = {
      evaluate: async (fn, arg) => {
        const result = await browser.send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      }
    };
    const guest = (code, allFrames = false) => root.evaluate(({ code, allFrames }) => new Promise(resolve => {
      document.querySelector('webview.active').executeScript({ code, mainWorld: true, allFrames }, resolve);
    }), { code, allFrames });
    await root.evaluate(url => { document.getElementById('address').value = url; document.getElementById('address-bar').requestSubmit(); }, `http://127.0.0.1:${server.address().port}`);
    for (let count = 0; count < 100; count++) { if ((await guest('document.title'))?.[0] === 'Native fixture') break; await pause(50); }
    const inspectionActivatedPage = await root.evaluate(async url => {
      const page = tools.pages.get(active.targetId);
      await page.goto(url);
      await page.title();
      const result = await page.client.send('Runtime.evaluate', { expression: 'navigator.userActivation.hasBeenActive', returnByValue: true, userGesture: false });
      return result.result.value;
    }, `http://127.0.0.1:${server.address().port}/?fresh-activation`);
    assert.equal(inspectionActivatedPage, false, 'automatic page inspection does not synthesize user activation');
    const privacy = await guest('({rtc:typeof RTCPeerConnection,initial:window.initialRTC,node:typeof require,canvas:(()=>{try{document.createElement("canvas").toDataURL();return "exposed"}catch(e){return e.name}})()})', true);
    assert.ok(privacy.length >= 3);
    for (const frame of privacy) { assert.equal(frame.rtc, 'undefined'); assert.equal(frame.initial, 'function'); assert.equal(frame.node, 'undefined'); assert.equal(frame.canvas, 'NotAllowedError'); }
    const post = async (route, body) => {
      const response = await fetch(bridge.origin + route, { method: 'POST', headers: { 'X-Obscura-Token': bridge.token }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    await post('/mcp', { method: 'tools/call', id: 1, params: { name: 'browser_fill', arguments: { selector: '#field', value: 'native verified' } } });
    await post('/mcp', { method: 'tools/call', id: 2, params: { name: 'browser_click', arguments: { selector: '#apply' } } });
    assert.equal((await guest('document.getElementById("result").textContent'))[0], 'native verified');
    await post('/mcp', { method: 'tools/call', id: 3, params: { name: 'browser_click', arguments: { selector: '#play' } } });
    await pause(700);
    assert.ok((await guest('document.getElementById("video").currentTime'))[0] > .2);
    // Serve Google's popup isolation header from the local cross-origin fixture.
    await root.evaluate(() => {
      // Reproduce X's opener policy and apply the same opt-in response handling.
      const view = document.querySelector('webview.active');
      view.request.onHeadersReceived.addListener(
        details => xLoginHeaders({ ...details, url: 'https://x.com/' }, true),
        { urls: ['http://127.0.0.1/*'], types: ['main_frame'] }, ['blocking', 'responseHeaders']);
      const loginURL = isLoginURL;
      isLoginURL = value => value.startsWith('http://localhost:') || loginURL(value);
      const configure = configureRequests;
      configureRequests = (view, options) => {
        configure(view, options);
        if (options?.oauthPopup) view.request.onHeadersReceived.addListener(
          details => oauthPopupHeaders({ ...details, url: 'https://accounts.google.com/gsi/transform' }),
          { urls: ['http://localhost/*'], types: ['main_frame'] }, ['blocking', 'responseHeaders']);
      };
    });
    await root.evaluate(async () => {
      const page = tools.pages.get(active.targetId);
      await page.goto(page.url());
    });
    // Sleep drops the browser-level socket. Drop it here, then open the popup while it is down.
    const health = async () => (await (await fetch(bridge.origin + '/health', { headers: { 'X-Obscura-Token': bridge.token } })).json()).browserConnected;
    assert.equal(await health(), true);
    await root.evaluate(() => { globalThis.__droppedBrowserClient = tools.browserClient; tools.browserClient.socket.terminate(); });
    await post('/mcp', { method: 'tools/call', id: 4, params: { name: 'browser_click', arguments: { selector: '#login' } } });
    let recovered = false;
    for (let attempt = 0; attempt < 100 && !recovered; attempt++) { recovered = await health(); if (!recovered) await pause(100); }
    assert.equal(recovered, true, '/health reports the browser connection recovered');
    assert.equal(await root.evaluate(() => tools.browserClient !== globalThis.__droppedBrowserClient && !globalThis.__droppedBrowserClient.open), true, 'a new browser client replaced the dropped one');
    assert.ok(await root.evaluate(() => document.querySelectorAll('webview').length >= 1), 'window and backend stay alive');
    await pause(1800);
    // The opener must receive its popup's result in the original guest, not a replacement URL.
    const oauthResult = await root.evaluate(() => new Promise(resolve => {
      const first = document.querySelector('webview');
      first.executeScript({ code: 'document.getElementById("result")?.textContent', mainWorld: true }, resolve);
    }));
    if (oauthResult[0] !== 'oauth-success') {
      const diagnostic = await fs.readFile(path.join(directory, 'logs/x-login.jsonl'), 'utf8');
      console.error(diagnostic.split('\n').filter(line => /target\.|popup\./.test(line)).slice(-15).join('\n'));
    }
    assert.equal(oauthResult[0], 'oauth-success');
    assert.equal(oauthRequests, 1, 'the original authorization GET reaches the server once');
    await root.evaluate(() => { nw.Window.get().focus(); document.querySelector('webview.active').focus(); });
    await pause(300);
    await post('/mcp', { method: 'tools/call', id: 5, params: { name: 'browser_evaluate', arguments: { expression: 'document.getElementById("video").requestFullscreen()' } } });
    await pause(1200);
    assert.equal((await guest('!!document.fullscreenElement'))[0], true);
    assert.equal(await root.evaluate(() => nw.Window.get().isFullscreen), true);
    assert.equal(await root.evaluate(() => document.body.classList.contains('media-fullscreen')), true);
    await guest('document.exitFullscreen()');
    await pause(1200);
    assert.equal((await guest('!!document.fullscreenElement'))[0], false);
    assert.equal(await root.evaluate(() => nw.Window.get().isFullscreen), false);
    assert.equal(await root.evaluate(() => document.body.classList.contains('media-fullscreen')), false);
    assert.equal(await root.evaluate(() => isLoginURL('https://www.youtube.com/')), false);
    assert.equal(await root.evaluate(() => isLoginURL('https://www.youtube.com/signin')), true);
    await post('/mcp', { method: 'tools/call', id: 6, params: { name: 'browser_evaluate', arguments: { expression: `void window.open('http://127.0.0.1:${server.address().port}/new-page', '_blank')` } } });
    for (let attempt = 0; attempt < 60; attempt++) { if ((await guest('location.pathname'))?.[0] === '/new-page') break; await pause(50); }
    assert.equal(await root.evaluate(() => document.querySelectorAll('webview').length), 2);
    assert.equal((await guest('location.pathname'))[0], '/new-page');
    await root.evaluate(() => document.querySelector('#tabs button:last-child .tab-close').click());
    const batch = (await guest('globalThis.__obscuraReading.collect()'))[0];
    const paragraph = batch.find(item => item.text.includes('Hello world.'));
    assert.ok(paragraph);
    await guest(`globalThis.__obscuraReading.apply(${JSON.stringify([{ ...paragraph, original: paragraph.text, text: '你好，世界。' }])})`);
    const translated = (await guest('({color:getComputedStyle(document.getElementById("reading-fixture")).color,text:document.getElementById("reading-fixture").textContent,translation:document.querySelector("[data-obscura-translation]").textContent})'))[0];
    assert.equal(translated.color, 'rgb(12, 34, 56)');
    assert.ok(translated.text.startsWith('Hello world.'));
    assert.equal(translated.translation, '你好，世界。');
    await guest('globalThis.__obscuraReading.clear()');
    await guest('(()=>{const node=document.getElementById("reading-fixture").firstChild;const range=document.createRange();range.setStart(node,0);range.setEnd(node,5);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new MouseEvent("mouseup"))})()');
    await pause(100);
    assert.equal(await root.evaluate(() => document.getElementById('selection-word').textContent), 'Hello');
    const image = (await fs.readFile(path.resolve(__dirname, '../native/icon.png'))).toString('base64');
    await root.evaluate(base64 => {
      const panel = document.getElementById('workbench').contentWindow;
      const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
      const transfer = new panel.DataTransfer();
      transfer.items.add(new panel.File([bytes], 'image.png', { type: 'image/png' }));
      const input = panel.document.getElementById('attachment-input');
      input.files = transfer.files;
      input.dispatchEvent(new panel.Event('change', { bubbles: true }));
    }, image);
    await pause(300);
    assert.equal(await root.evaluate(() => document.getElementById('workbench').contentDocument.querySelectorAll('#pending-attachments .attachment-card').length), 1);
    await root.evaluate(() => document.getElementById('workbench').contentDocument.querySelector('.attachment-remove').click());
    assert.equal(await root.evaluate(() => document.getElementById('workbench').contentDocument.querySelectorAll('#pending-attachments .attachment-card').length), 0);
    await root.evaluate(() => document.getElementById('theme-toggle').click());
    await pause(300);
    assert.equal(await root.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await root.evaluate(() => document.getElementById('workbench').contentDocument.documentElement.dataset.theme), 'light');
    await root.evaluate(() => document.getElementById('theme-toggle').click());
    await pause(300);
    for (let index = 0; index < 21; index++) await post('/dictionary/save', { word: 'browser' + index, partOfSpeech: '名词', translation: '浏览器', context: 'Open the browser.' });
    await root.evaluate(() => document.getElementById('workbench').contentDocument.querySelector('[data-tab="reading"]').click());
    await pause(150);
    assert.equal(await root.evaluate(() => document.getElementById('workbench').contentDocument.querySelectorAll('.dictionary-card').length), 20);
    await root.evaluate(() => document.getElementById('workbench').contentDocument.getElementById('dictionary-next').click());
    await pause(150);
    assert.equal(await root.evaluate(() => document.getElementById('workbench').contentDocument.querySelectorAll('.dictionary-card').length), 1);
    await root.evaluate(url => { document.getElementById('address').value = url; document.getElementById('address-bar').requestSubmit(); }, `127.0.0.1:${server.address().port}/second`);
    for (let attempt = 0; attempt < 60; attempt++) { if ((await guest('location.pathname'))?.[0] === '/second') break; await pause(50); }
    assert.equal((await guest('location.pathname'))[0], '/second');
    await root.evaluate(async () => {
      const client = tools.pages.get(active.targetId).client;
      globalThis.removeDiagnosticFixture = client.on('Fetch.requestPaused', event => {
        client.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from('An unexpected error occurred. Please try again.').toString('base64') }).catch(() => {});
      });
      await client.send('Fetch.enable', { patterns: [{ urlPattern: 'https://x.com/i/flow/login?fixture=*', requestStage: 'Request' }] });
    });
    await post('/mcp', { method: 'tools/call', id: 7, params: { name: 'browser_evaluate', arguments: { expression: 'fetch("https://x.com/i/flow/login?fixture=private-query", {mode:"no-cors"}).then(()=>true)' } } });
    await pause(200);
    await root.evaluate(async () => { globalThis.removeDiagnosticFixture(); await tools.pages.get(active.targetId).client.send('Fetch.disable'); });
    const logState = await (await fetch(bridge.origin + '/diagnostics', { headers: { 'X-Obscura-Token': bridge.token } })).json();
    const diagnosticLog = await fs.readFile(logState.file, 'utf8');
    assert.ok(diagnosticLog.includes('app.ready'));
    const diagnosticRecords = diagnosticLog.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(diagnosticRecords.some(record => record.event === 'request' && record.url === 'https://x.com/i/flow/login'));
    assert.ok(diagnosticRecords.some(record => record.event === 'response' && record.status === 200));
    assert.ok(!diagnosticLog.includes('private-query'));
    assert.ok(!diagnosticLog.includes(bridge.token));
    const settings = await (await fetch(bridge.origin + '/settings', { headers: { 'X-Obscura-Token': bridge.token } })).json();
    assert.equal(settings.theme, 'dark');
  } finally {
    if (application?.process.exitCode === null) application.process.kill('SIGTERM');
    browser?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
