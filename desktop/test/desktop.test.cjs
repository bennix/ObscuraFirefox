const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { launch } = require('../app.cjs');
const { Settings, defaults } = require('../settings.cjs');
const { chat } = require('../ai.cjs');
const { Engine } = require('../engine.cjs');

test('settings keep secrets in Keychain, never in JSON or UI responses', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-settings-'));
  let secret = '';
  const keychain = async (_, args) => {
    if (args[0] === 'add-generic-password') secret = args.at(-1);
    if (args[0] === 'delete-generic-password') secret = '';
    if (args[0] === 'find-generic-password' && !secret) throw new Error('Not found');
    return { stdout: secret };
  };
  try {
    const settings = new Settings(directory, keychain);
    const result = await settings.save({ apiKey: 'test-secret-never-write', models: ['openai/gpt-5.4', 'custom/model'], model: 'custom/model' });
    assert.equal(result.hasKey, true); assert.equal(result.model, 'custom/model');
    assert.doesNotMatch(JSON.stringify(result), /test-secret/);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'), /test-secret/);
    assert.equal((await new Settings(directory, keychain).read()).model, 'custom/model');
    assert.equal((await settings.save({ models: ['custom/model'], deleteKey: true })).hasKey, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('ZenMux loop sends requested model, dispatches MCP tool, and returns result', async () => {
  let calls = 0, usedTool = '';
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://zenmux.ai/api/v1/chat/completions');
    const body = JSON.parse(options.body); assert.equal(body.model, 'openai/gpt-5.4');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    calls++;
    if (body.messages[0].content.includes('独立任务观察哨')) return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ status: 'complete', reason: '已核实总结内容', checks: [{ item: '总结已覆盖网页', passed: true }] }) } }] }) };
    return { ok: true, json: async () => ({ choices: [{ message: calls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }] }
      : { role: 'assistant', content: '页面总结已完成。' } }] }) };
  };
  const messages = await chat({ messages: [{ role: 'user', content: '总结网页' }], model: 'openai/gpt-5.4', key: 'fixture-key', fetcher,
    dispatch: async name => { usedTool = name; return { content: [{ type: 'text', text: 'Fixture page' }] }; } });
  assert.equal(calls, 3); assert.equal(usedTool, 'browser_snapshot');
  assert.equal(messages.at(-1).content, '页面总结已完成。');
  assert.ok(messages.some(message => message.role === 'tool'));
});

test('real Obscura engine renders and evaluates', async () => {
  const engine = new Engine(path.resolve(__dirname, '../../target/release/obscura'));
  try {
    await engine.call('browser_navigate', { url: 'data:text/html,<title>Engine fixture</title><h1>Native engine</h1>' });
    assert.match((await engine.call('browser_evaluate', { expression: 'document.title' })).content[0].text, /Engine fixture/);
    const shot = await engine.call('browser_screenshot', { width: 800, height: 600 });
    const png = Buffer.from(shot.content.find(item => item.type === 'image').data, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    fs.writeFileSync('/tmp/obscura-engine-verified.png', png);
  } finally { engine.close(); }
});

test('observer rejects premature completion and requires a passed checklist', async () => {
  let audits = 0, turns = 0;
  const fetcher = async (_, options) => {
    const body = JSON.parse(options.body), observer = body.messages[0].content.includes('独立任务观察哨');
    let content;
    if (observer) {
      audits++;
      content = JSON.stringify(audits === 1
        ? { status: 'complete', reason: '数量尚未满足', checks: [{ item: '收集 3 条结果', passed: false }], next_action: '补齐结果' }
        : { status: 'complete', reason: '3 条结果均已核实', checks: [{ item: '收集 3 条结果', passed: true }] });
    } else { turns++; content = turns === 1 ? '完成了' : '已补齐 3 条结果'; }
    return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
  };
  const events = [];
  const result = await chat({ messages: [{ role: 'user', content: '收集 3 条结果' }], model: 'fixture', key: 'fixture', fetcher,
    dispatch: async () => ({ content: [{ type: 'text', text: 'evidence' }] }), onEvent: event => events.push(event) });
  assert.equal(turns, 2); assert.equal(audits, 2);
  assert.ok(events.some(event => event.status === 'continue'));
  assert.equal(events.at(-1).status, 'complete');
  assert.match(result.at(-1).content, /3 条/);
});

test('long task stops honestly at tool budget instead of claiming completion', async () => {
  let used = 0;
  const result = await chat({ messages: [{ role: 'user', content: '长任务' }], model: 'fixture', key: 'fixture', maxTools: 2,
    dispatch: async () => { used++; return { content: [{ type: 'text', text: 'working' }] }; },
    fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c' + used, type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }] } }] }) }) });
  assert.equal(used, 2); assert.match(result.at(-1).content, /尚未验收完成/);
});

test('Chrome 157 Stable: real video, privacy in every frame, images, GUI and MCP', { timeout: 120000 }, async () => {
  const video = fs.readFileSync('/tmp/obscura-media-test.mp4');
  const fixture = http.createServer((req, res) => {
    if (/^\/sniff-[ab]\.m3u8$/.test(req.url)) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-ENDLIST\n'); return;
    }
    if (req.url === '/video.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length }); res.end(video); return; }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/frame') { res.end('<script>window.initialRTC=typeof RTCPeerConnection</script><p>Cross origin</p>'); return; }
    res.end(`<title>Media fixture</title><script>window.initialRTC=typeof RTCPeerConnection</script><h1>Media playback</h1><input id="name"><button id="apply" onclick="document.querySelector('h1').textContent=document.querySelector('#name').value">Apply</button><video controls src="/video.mp4"></video><iframe src="http://localhost:${fixture.address().port}/frame"></iframe><iframe srcdoc="<p>Opaque frame</p>"></iframe>`);
  });
  await new Promise(resolve => fixture.listen(0, resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-chrome-test-'));
  let app;
  try {
    let proxyConfig = { mode: 'system', url: '' };
    let proxyAddress = '';
    let generations = 0;
    const report = '# 流式报告\n\n**重点**与行内公式 $x^2+y^2=z^2$。\n\n$$\\int_0^1 x\\,dx=\\frac{1}{2}$$\n\n|项目|结果|\n|---|---|\n|网络|已恢复|\n\n```js\nconst value = 1;\n```\n\n<img src="x" onerror="window.unsafeMarkup=true"><script>window.unsafeMarkup=true</script>';
    const aiFetcher = async (_, options) => {
      const input = JSON.parse(options.body);
      if (!input.stream) return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ status: 'complete', reason: '页面已读取，报告已完整输出', checks: [{ item: '生成报告', passed: true }] }) } }] });
      generations++;
      const chunks = generations % 2 === 1
        ? [{ content: '正在读取当前页面…' }, { tool_calls: [{ index: 0, id: 'snapshot-call', type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }] }]
        : [{ content: report.slice(0, 20) }, { content: report.slice(20) }];
      const data = [...chunks.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`), 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'];
      let index = 0, canceled = false;
      return new Response(new ReadableStream({
        async pull(controller) {
          if (index === data.length) { controller.close(); return; }
          await new Promise(resolve => setTimeout(resolve, 80));
          if (!canceled) controller.enqueue(new TextEncoder().encode(data[index++]));
        },
        cancel() { canceled = true; }
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    app = await launch({ directory, testing: true, aiFetcher, settings: {
      read: async () => ({ hasKey: true, models: defaults, model: defaults[0], proxy: proxyConfig }),
      key: async () => 'fixture-only',
      proxyURL: async () => proxyAddress
    } });
    const context = app.tools.browser.contexts()[0];
    assert.match(app.tools.browser.version(), /^157\./);
    const page = context.pages().find(p => /^https?:/.test(p.url()));
    await page.goto(`http://127.0.0.1:${fixture.address().port}`);
    await page.waitForSelector('video');
    await page.locator('video').click();
    await page.evaluate(async () => { const video = document.querySelector('video'); video.muted = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector('video').currentTime > .3);
    assert.equal(await page.evaluate(() => document.querySelector('video').videoWidth), 320);
    await page.waitForFunction(() => frames.length === 2);
    for (const frame of page.frames()) {
      const result = await frame.evaluate(() => ({ rtc: typeof RTCPeerConnection, legacy: typeof webkitRTCPeerConnection, initial: window.initialRTC,
        audio: typeof OfflineAudioContext, node: typeof require, canvas: (() => { try { document.createElement('canvas').toDataURL(); return 'exposed'; } catch (e) { return e.name; } })() }));
      assert.equal(result.rtc, 'undefined', frame.url()); assert.equal(result.legacy, 'undefined');
      assert.equal(result.audio, 'undefined'); assert.equal(result.node, 'undefined'); assert.equal(result.canvas, 'NotAllowedError');
      if (frame.url() !== 'about:srcdoc') assert.equal(result.initial, 'function');
    }
    const worker = context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${app.extensionId}/`));
    assert.equal(await worker.evaluate(async () => (await chrome.privacy.network.webRTCIPHandlingPolicy.get({})).value), 'disable_non_proxied_udp');
    const unauthorized = await fetch(app.origin + '/health'); assert.equal(unauthorized.status, 401);
    const post = async (route, body) => {
      const response = await fetch(app.origin + route, { method: 'POST', headers: { 'X-Obscura-Token': app.token }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    await post('/mcp', { method: 'tools/call', id: 1, params: { name: 'browser_fill', arguments: { selector: '#name', value: 'MCP verified' } }, tabUrl: page.url() });
    await post('/mcp', { method: 'tools/call', id: 2, params: { name: 'browser_click', arguments: { selector: '#apply' } }, tabUrl: page.url() });
    assert.equal(await page.locator('h1').textContent(), 'MCP verified');
    await context.route('https://x.com/obscura-test', route => route.fulfill({ contentType: 'text/html', body: '<title>X image fixture</title><img src="https://pbs.twimg.com/media/test?name=small" width="200">' }));
    await context.route('https://pbs.twimg.com/media/test?*', route => route.fulfill({ contentType: 'image/png', body: fs.readFileSync('/tmp/obscura-engine-verified.png') }));
    await page.goto('https://x.com/obscura-test'); await page.locator('img').click();
    // Closed shadow DOM intentionally isolates the overlay from the website.
    await page.waitForTimeout(200);
    const cdp = await context.newCDPSession(page);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = (node, id) => {
      if (node.attributes?.some((value, index, attrs) => index % 2 === 0 && value === 'id' && attrs[index + 1] === id)) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const match = find(child, id); if (match) return match; }
    };
    const imageNode = find(root, 'image'), zoomButton = find(root, 'in');
    assert.ok(imageNode && zoomButton, 'image viewer opened');
    const style = async () => (await cdp.send('DOM.getAttributes', { nodeId: imageNode.nodeId })).attributes.join(' ');
    const beforeZoom = await style();
    const { model: box } = await cdp.send('DOM.getBoxModel', { nodeId: zoomButton.nodeId });
    await page.mouse.click((box.content[0] + box.content[2]) / 2, (box.content[1] + box.content[5]) / 2);
    assert.notEqual(await style(), beforeZoom);
    const beforePan = await style();
    await page.mouse.move(500, 400); await page.mouse.down(); await page.mouse.move(560, 450); await page.mouse.up();
    assert.notEqual(await style(), beforePan);
    const beforeWheel = await style(); await page.mouse.wheel(0, -180); await page.waitForTimeout(100);
    assert.notEqual(await style(), beforeWheel);
    await cdp.detach();
    await page.screenshot({ path: '/tmp/obscura-chrome-image-viewer.png' });
    await page.keyboard.press('Escape');
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${app.extensionId}/panel.html`);
    await panel.waitForFunction(() => document.getElementById('version').textContent.includes('157.0.8103.78'));
    await panel.locator('[data-tab=settings]').click();
    assert.equal(await panel.locator('#api-key').getAttribute('type'), 'password');
    assert.equal(await panel.locator('a').getAttribute('href'), 'https://zenmux.ai/invite/GBQMC5');
    assert.match(await panel.locator('#models').inputValue(), /anthropic\/claude-sonnet-4.6/);
    await panel.screenshot({ path: '/tmp/obscura-chrome-settings.png' });
    await panel.locator('[data-tab=chat]').click(); await panel.screenshot({ path: '/tmp/obscura-chrome-workspace.png' });
    await panel.locator('#prompt').fill('读取页面并生成公式报告');
    await panel.locator('#send').click();
    await panel.waitForFunction(() => document.getElementById('conversation').textContent.includes('正在读取当前页面'));
    await panel.waitForFunction(() => !document.getElementById('send').disabled);
    assert.ok(await panel.locator('.markdown-body .katex').count() >= 2,
      await panel.locator('#conversation').innerHTML() + '\nSTATUS ' + await panel.locator('#status').textContent());
    assert.ok(await panel.locator('.markdown-body table').count() >= 1);
    assert.ok(await panel.locator('.markdown-body pre code').count() >= 1);
    assert.equal(await panel.evaluate(() => window.unsafeMarkup), undefined);
    assert.equal(await panel.locator('.markdown-body [onerror]').count(), 0);
    assert.equal(await panel.locator('.markdown-body script').count(), 0);
    assert.match(await panel.locator('#watch-state').textContent(), /验收通过/);
    await panel.screenshot({ path: '/tmp/obscura-stream-markdown-latex.png' });
    // Disconnect the local response, then recover its completed task without resubmitting it.
    const requestId = 'disconnect-fixture';
    const stream = await fetch(app.origin + '/chat', {
      method: 'POST', headers: { 'X-Obscura-Token': app.token },
      body: JSON.stringify({ stream: true, requestId, model: defaults[0], tabUrl: page.url(), messages: [{ role: 'user', content: '恢复测试' }] })
    });
    const reader = stream.body.getReader();
    await reader.read(); await reader.cancel();
    let recovered;
    for (let count = 0; count < 80; count++) {
      recovered = await (await fetch(app.origin + '/chat-state', { headers: { 'X-Obscura-Token': app.token } })).json();
      if (recovered.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(recovered.requestId, requestId);
    assert.equal(recovered.status, 'done');
    assert.match(recovered.history.at(-1).content, /流式报告/);
    assert.equal(generations, 4);
    let proxyRequests = 0;
    const browserProxy = http.createServer((_, response) => {
      proxyRequests++;
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Browser proxy verified</title><h1>Proxy transport</h1>');
    });
    await new Promise(resolve => browserProxy.listen(0, '127.0.0.1', resolve));
    try {
      proxyAddress = `http://127.0.0.1:${browserProxy.address().port}`;
      proxyConfig = { mode: 'manual', url: proxyAddress };
      await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'apply-proxy' }));
      const nativeProxy = await worker.evaluate(async () => (await chrome.proxy.settings.get({})).value);
      assert.equal(nativeProxy.mode, 'fixed_servers');
      await page.goto('http://proxy-verification.invalid', { timeout: 10000 });
      assert.equal(await page.title(), 'Browser proxy verified');
      assert.ok(proxyRequests > 0);
    } finally {
      proxyConfig = { mode: 'system', url: '' };
      await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'apply-proxy' }));
      browserProxy.closeAllConnections();
      await new Promise(resolve => browserProxy.close(resolve));
    }
    const selectedDownloads = [];
    await context.route(app.origin + '/downloads', async route => {
      const input = route.request().postDataJSON();
      if (input.action === 'add') selectedDownloads.push(input.args);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(input.action === 'inspect'
        ? { formats: [{ id: 'fixture-720', label: '720p', size: 1000 }] } : { downloads: [] }) });
    });
    await page.goto(`http://127.0.0.1:${fixture.address().port}`);
    await page.bringToFront();
    await page.evaluate(async () => { await fetch('/sniff-a.m3u8'); await fetch('/sniff-b.m3u8'); });
    await panel.bringToFront();
    await panel.locator('[data-tab=downloads]').click();
    await panel.locator('#media-refresh').click();
    const selectedCard = panel.locator('.media-card').filter({ hasText: '/sniff-a.m3u8' });
    await selectedCard.waitFor();
    assert.equal(selectedDownloads.length, 0, 'sniffing does not automatically start downloads');
    await selectedCard.getByText('解析清晰度', { exact: true }).click();
    await selectedCard.locator('select').selectOption('fixture-720');
    await selectedCard.locator('input[type=checkbox]').check();
    await panel.locator('#media-download-selected').click();
    await panel.waitForTimeout(100);
    assert.equal(selectedDownloads.length, 1);
    assert.ok(selectedDownloads[0].url.endsWith('/sniff-a.m3u8'));
    assert.equal(selectedDownloads[0].format, 'fixture-720');
    await panel.screenshot({ path: '/tmp/obscura-media-selection.png' });
  } finally {
    await app?.close();
    await new Promise(resolve => fixture.close(resolve));
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
