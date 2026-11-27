const http = require('node:http');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Engine } = require('./engine.cjs');
const { ChromeTools, definitions } = require('./chrome-tools.cjs');
const { Settings } = require('./settings.cjs');
const { chat } = require('./ai.cjs');
const { ProxyTransport } = require('./proxy.cjs');
const { probeModel } = require('./model-test.cjs');
const { Downloads, toolDefinitions } = require('./downloads.cjs');
const { AuthDiagnostics } = require('./auth-diagnostics.cjs');
const { Reading } = require('./reading.cjs');
const { Attachments } = require('./attachments.cjs');
async function launch(options = {}) {
  const directory = options.directory || path.join(os.homedir(), 'Library/Application Support/Obscura Desktop');
  await fs.mkdir(directory, { recursive: true });
  const lock = path.join(directory, 'launcher.json');
  if (!options.testing) {
    try {
      const old = JSON.parse(await fs.readFile(lock, 'utf8'));
      const response = await fetch(old.origin + '/health', { headers: { 'X-Obscura-Token': old.token }, signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json();
        if (old.standalone && old.browserEndpoint) await fetch(old.browserEndpoint + '/json/version', { signal: AbortSignal.timeout(1000) });
        if (health.browserConnected !== false) return null;
      }
    } catch {}
  }
  const tools = options.browserTools || new ChromeTools(), settings = options.settings || new Settings(directory);
  const diagnostics = new AuthDiagnostics(directory);
  tools.diagnostics = diagnostics;
  const transport = new ProxyTransport(settings);
  const downloads = new Downloads({ directory, browserTools: tools, transport, output: options.downloadOutput });
  const attachments = new Attachments(directory);
  tools.attachments = attachments;
  const reading = new Reading({ directory, settings, fetcher: options.aiFetcher || ((url, args) => transport.fetch(url, args)) });
  const allDefinitions = [...(tools.definitions || definitions), ...toolDefinitions];
  let engine, browserProcess, controller, operation = false, chromeVersion = 'starting';
  const token = crypto.randomBytes(32).toString('hex');
  // A per-launch URL lets the first tab wait locally until Firefox has installed
  // its proxy listener. It grants no access to authenticated backend APIs.
  const startupPath = options.extensionBridge && options.startupURL ? '/startup/' + crypto.randomUUID() : null;
  const events = [];
  let liveChat = null;
  let network = { status: 'idle' };
  tools.onNetwork = event => { network = event; };
  const taskFile = path.join(directory, 'last-task.json');
  let task = null;
  try {
    task = JSON.parse(await fs.readFile(taskFile, 'utf8'));
    if (task.status === 'running' || task.status === 'checking') { task.status = 'interrupted'; task.reason = '应用已重启，上一任务没有完成验收。'; }
  } catch {}
  let taskWrite = Promise.resolve();
  function saveTask() {
    const content = JSON.stringify(task, null, 2);
    taskWrite = taskWrite.then(() => fs.writeFile(taskFile, content, { mode: 0o600 })).catch(() => {});
  }
  const dispatch = async (name, args) => {
    let timer;
    try {
      const execution = name.startsWith('downloads_') ? downloads.call(name, args) : tools.call(name, args);
      return await Promise.race([execution, new Promise((_, reject) => {
        const timeout = name === 'browser_navigate' ? 370000 : 60000;
        timer = setTimeout(() => { tools.stop().catch(() => {}); reject(new Error('网页操作等待超时，已请求中止。')); }, timeout);
      })]);
    } finally { clearTimeout(timer); }
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.end(JSON.stringify({ type: data.error ? 'error' : 'done', ...data }) + '\n'); return; }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (startupPath && req.method === 'GET' && req.url === startupPath) {
      const redirect = () => {
        res.writeHead(302, { Location: options.startupURL, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end();
      };
      if (tools.browserClient.open) redirect();
      else {
        tools.wss.once('routing-ready', redirect);
        res.once('close', () => tools.wss.off('routing-ready', redirect));
      }
      return;
    }
    if (req.headers['x-obscura-token'] !== token) { send(401, { error: 'Unauthorized' }); return; }
    try {
      if (req.method === 'GET') {
        if (req.url === '/health') { send(200, { version: require('./package.json').version, browserConnected: (options.browserEndpoint || options.extensionBridge) ? tools.browserClient?.open === true : true, browserEngine: options.extensionBridge ? 'Firefox' : 'Chromium', chrome: chromeVersion, channel: 'Stable', features: ['streaming', 'markdown', 'latex', 'proxy', 'downloads', 'media-sniffer', 'hls', 'attachments', 'themes', 'search', 'translation', 'dictionary', 'fullscreen', 'youtube-ad-speed'], aiBusy: operation, events: events.slice(-24), task, network }); return; }
        if (req.url === '/diagnostics') { send(200, await diagnostics.flush()); return; }
        if (req.url === '/chat-state') { send(200, liveChat || { status: 'idle', messages: [] }); return; }
        if (req.url.startsWith('/attachments/')) { send(200, await attachments.get(req.url.split('/').at(-1), true)); return; }
        if (req.url.startsWith('/dictionary?') || req.url === '/dictionary') {
          const url = new URL(req.url, 'http://localhost');
          send(200, await reading.list(url.searchParams.get('q') || '', url.searchParams.get('page'))); return;
        }
        if (req.url === '/settings') { send(200, await settings.read()); return; }
        if (req.url === '/proxy-config') {
          const config = await settings.read();
          if (config.proxy?.mode !== 'manual') { send(200, { mode: 'system' }); return; }
          const proxy = new URL(await settings.proxyURL());
          send(200, { mode: 'fixed_servers', rules: {
            singleProxy: { scheme: proxy.protocol.replace(':', '').replace('socks5h', 'socks5'), host: proxy.hostname, port: Number(proxy.port || (proxy.protocol.startsWith('socks') ? 1080 : proxy.protocol === 'https:' ? 443 : 80)) },
            bypassList: ['localhost', '127.0.0.1', '[::1]']
          } });
          return;
        }
        if (req.url === '/proxy-auth') {
          const config = await settings.read();
          const proxy = config.proxy?.mode === 'manual' ? new URL(await settings.proxyURL()) : null;
          send(200, proxy ? { host: proxy.hostname, port: Number(proxy.port || (proxy.protocol.startsWith('socks') ? 1080 : proxy.protocol === 'https:' ? 443 : 80)), username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } : {});
          return;
        }
        send(404, { error: 'Not found' }); return;
      }
      if (req.method !== 'POST') { send(405, { error: 'Method not allowed' }); return; }
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) { body += chunk; if (body.length > 64000000) throw new Error('请求过大'); }
      const input = JSON.parse(body || '{}');
      if (req.url === '/proxy-route') { send(200, await transport.browserRoute(String(input.url))); return; }
      if (req.url === '/diagnostics/open') {
        await diagnostics.flush();
        const child = spawn(process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'notepad.exe' : 'xdg-open', process.platform === 'darwin' ? ['-t', diagnostics.file] : [diagnostics.file], { stdio: 'ignore', windowsHide: true });
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('日志查看器打开失败'))); });
        send(200, { ok: true }); return;
      }
      if (req.url === '/diagnostics/start') { diagnostics.record('capture.marker', { reason: 'user-request', xCompatibility: tools.authCompatibility === true }); send(200, await diagnostics.flush()); return; }
      if (req.url === '/settings') { send(200, await settings.save(input)); return; }
      if (req.url === '/model-test') {
        const config = await settings.read();
        const key = String(input.apiKey || '').trim() || await settings.key();
        const model = String(input.model || config.model || '').trim();
        const endpoint = `${config.baseURL.replace(/\/$/, '')}/chat/completions`;
        const proxy = await transport.resolve(endpoint);
        send(200, await probeModel({ key, model, baseURL: config.baseURL, proxy, signal: AbortSignal.timeout(20000) }));
        return;
      }
      if (req.url === '/translate' || req.url === '/lookup') {
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]);
        send(200, await (req.url === '/translate' ? reading.translate(input, signal) : reading.lookup(input, signal))); return;
      }
      if (req.url === '/dictionary/save') { send(200, await reading.save(input)); return; }
      if (req.url === '/attachments') { send(200, await attachments.add(input)); return; }
      if (req.url === '/downloads') {
        const actions = {
          list: () => downloads.list(), add: () => downloads.add(input.args || {}),
          pause: () => downloads.act('pause', input.ids || []), resume: () => downloads.act('start', input.ids || []),
          remove: () => downloads.act('remove', input.ids || []), inspect: () => downloads.inspect(input.url)
        };
        if (!actions[input.action]) throw new Error('无效的下载操作');
        send(200, await actions[input.action]()); return;
      }
      if (req.url === '/chat-clear') {
        if (operation) throw new Error('请先停止当前任务');
        liveChat = null;
        await attachments.clear();
        send(200, { ok: true }); return;
      }
      if (req.url === '/cancel') { controller?.abort(); tools.stop().catch(() => {}); send(200, { ok: true }); return; }
      if (req.url === '/chat') {
        if (operation) throw new Error('AI 正在执行上一轮操作');
        const config = await settings.read(), key = await settings.key();
        if (!key) throw new Error('请先在设置中保存 ZenMux API Key');
        if (!config.models.includes(input.model)) throw new Error('请选择已保存的模型');
        if (!Array.isArray(input.messages) || !input.messages.length) throw new Error('消息不能为空');
        if (operation) throw new Error('AI 正在执行上一轮操作，请恢复任务连接');
        operation = true; events.length = 0; controller = new AbortController();
        const taskSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(1200000)]);
        tools.signal = taskSignal;
        liveChat = { requestId: input.requestId || crypto.randomUUID(), status: 'running', messages: structuredClone(input.messages), history: structuredClone(input.messages) };
        const messageIndexes = new Map();
        if (input.stream) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          res.flushHeaders();
          res.write(JSON.stringify({ type: 'start', requestId: liveChat.requestId }) + '\n');
        }
        const heartbeat = input.stream ? setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write('{"type":"heartbeat"}\n');
        }, 10000) : null;
        controller.signal.addEventListener('abort', () => { tools.stop().catch(() => {}); }, { once: true });
        task = { status: 'running', startedAt: new Date().toISOString(), goal: input.messages.filter(m => m.role === 'user' && typeof m.content === 'string').at(-1)?.content, steps: 0, checks: [], reason: '执行中，尚未验收' };
        saveTask();
        try {
          tools.currentPage = null; tools.activeURL = input.tabUrl; tools.currentPage = await tools.page();
          const messages = await chat({ messages: input.messages, model: input.model, key,
            tools: allDefinitions,
            apiMessages: messages => attachments.apiMessages(messages),
            fetcher: options.aiFetcher || ((url, args) => transport.fetch(url, args)),
            dispatch, signal: taskSignal,
            onEvent: event => {
              if (event.type === 'checkpoint') { liveChat.history = structuredClone(event.messages); return; }
              if (event.type === 'assistant-start') {
                messageIndexes.set(event.messageId, liveChat.messages.length);
                liveChat.messages.push({ role: 'assistant', content: '' });
              }
              const index = messageIndexes.get(event.messageId);
              if (event.type === 'assistant-delta') liveChat.messages[index].content += event.delta;
              if (event.type === 'assistant-reset') liveChat.messages[index].content = '';
              if (event.type === 'assistant-end') liveChat.messages[index] = { role: 'assistant', content: event.message.content || '' };
              if (event.type === 'network') network = event;
              if (input.stream && !res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + '\n');
              if (!event.tool) return;
              events.push(event);
              if (event.tool === '观察哨') Object.assign(task, { status: event.status, reason: event.reason || '正在检查完成度', checks: event.checks || task.checks, steps: event.steps });
              else if (event.status === 'running') { task.steps++; task.status = 'running'; task.currentTool = event.tool; }
              saveTask();
            } });
          task.finishedAt = new Date().toISOString(); saveTask();
          liveChat.status = 'done'; liveChat.messages = messages; liveChat.history = messages;
          send(200, { messages });
        } catch (error) {
          liveChat.status = 'error'; liveChat.error = error.name === 'AbortError' ? '操作已停止' : error.message;
          liveChat.history.push({ role: 'assistant', content: `本轮尚未验收完成。${liveChat.error}` });
          task.status = controller.signal.aborted ? 'stopped' : 'error'; task.reason = error.message; saveTask(); throw error;
        } finally { clearInterval(heartbeat); operation = false; tools.currentPage = null; tools.activeURL = null; tools.signal = null; controller = null; }
        return;
      }
      if (req.url === '/mcp') {
        if (operation) throw new Error('AI 正在操作页面，请稍候或停止 AI');
        if (input.method === 'initialize') { send(200, { jsonrpc: '2.0', id: input.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'obscura-chrome-mcp', version: '0.1.0' } } }); return; }
        if (input.method === 'tools/list') { send(200, { jsonrpc: '2.0', id: input.id, result: { tools: allDefinitions } }); return; }
        if (input.method !== 'tools/call') throw new Error('Unsupported MCP method');
        tools.currentPage = null; tools.activeURL = input.tabUrl;
        const result = await dispatch(input.params.name, input.params.arguments || {});
        send(200, { jsonrpc: '2.0', id: input.id, result }); return;
      }
      if (req.url === '/obscura') {
        if (!['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_evaluate', 'browser_click', 'browser_fill'].includes(input.tool)) throw new Error('Unsupported Obscura tool');
        if (!engine) { const name = process.platform === 'win32' ? 'obscura.exe' : 'obscura'; engine = new Engine(options.binary || (existsSync(path.join(__dirname, 'bin', name)) ? path.join(__dirname, 'bin', name) : path.resolve(__dirname, '../target/release', name))); }
        send(200, await engine.call(input.tool, input.arguments || {})); return;
      }
      send(404, { error: 'Not found' });
    } catch (error) { send(400, { error: error.name === 'AbortError' ? '操作已停止' : error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (options.browserEndpoint || options.extensionBridge) {
    tools.authCompatibility = (await settings.read()).authCompatibility;
    if (options.extensionBridge) {
      tools.attach(server, token);
      chromeVersion = options.browserVersion || 'source build';
    } else {
      await tools.connect(options.browserEndpoint);
      const version = await (await fetch(options.browserEndpoint + '/json/version')).json();
      chromeVersion = version.Browser.split('/').at(-1);
    }
    let updateTimer;
    if (options.extensionBridge && !options.testing) {
      const check = () => require('./firefox/updates.cjs').checkUpdates(directory, transport, tools)
        .catch(error => diagnostics.record('update.check', { error: error.message }));
      tools.wss.once('routing-ready', check);
      updateTimer = setInterval(check, 60 * 60 * 1000);
      updateTimer.unref();
    }
    let closing, closeReason;
    const finished = new Set();
    // Each teardown step runs once; a failed step is retried by the next close() call.
    const steps = [
      () => { clearInterval(updateTimer); controller?.abort(); engine?.close(); },
      () => diagnostics.record('app.close', { reason: closeReason, browserConnected: tools.browserClient?.open === true }),
      () => downloads.close(), () => transport.close(), () => tools.close(), () => server.close(),
      () => diagnostics.flush(),
      async () => { try { const record = JSON.parse(await fs.readFile(lock, 'utf8')); if (record.token === token) await fs.rm(lock, { force: true }); } catch {} }
    ];
    const close = (reason = 'shutdown-request') => {
      if (closing) return closing;
      closeReason ??= reason;
      const attempt = (async () => {
        let failure;
        for (const step of steps) {
          if (finished.has(step)) continue;
          try { await step(); finished.add(step); } catch (error) { failure ??= error; }
        }
        if (failure) throw failure;
      })();
      closing = attempt;
      attempt.catch(() => { if (closing === attempt) closing = undefined; });
      return attempt;
    };
    // A dropped browser socket (for example after sleep) is recovered by NativeTools; only an unrecoverable loss ends the backend.
    tools.onBrowserLost = () => close('browser-disconnected').catch(() => {});
    diagnostics.record('app.ready', { version: require('./package.json').version, chromium: chromeVersion, xCompatibility: tools.authCompatibility === true });
    await fs.writeFile(lock, JSON.stringify({ origin, token, standalone: true, browserEndpoint: options.browserEndpoint }), { mode: 0o600 });
    return { origin, startupURL: startupPath && origin + startupPath, token, tools, settings, server, downloads, diagnostics, close, directory };
  }
  const extension = path.join(directory, 'extension');
  await fs.cp(path.join(__dirname, 'extension'), extension, { recursive: true });
  await fs.writeFile(path.join(extension, 'bridge-config.js'), `globalThis.BRIDGE=${JSON.stringify({ origin, token })};\n`, { mode: 0o600 });
  await fs.writeFile(lock, JSON.stringify({ origin, token }), { mode: 0o600 });
  const profile = path.join(directory, 'chrome');
  await fs.mkdir(profile, { recursive: true });
  await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  const preferences = path.join(profile, 'Default/Preferences');
  await fs.mkdir(path.dirname(preferences), { recursive: true });
  let prefs = {};
  try { prefs = JSON.parse(await fs.readFile(preferences, 'utf8')); } catch {}
  prefs.profile ||= {}; prefs.profile.default_content_setting_values ||= {};
  Object.assign(prefs.profile.default_content_setting_values, { media_stream_mic: 2, media_stream_camera: 2, geolocation: 2, notifications: 2 });
  await fs.writeFile(preferences, JSON.stringify(prefs));
  const executable = options.chrome || path.join(__dirname, 'runtime/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const launchConfig = await settings.read();
  const proxyArguments = [];
  if (launchConfig.proxy?.mode === 'manual') {
    const proxy = new URL(await settings.proxyURL());
    proxy.username = ''; proxy.password = '';
    proxyArguments.push('--proxy-server=' + proxy.href.replace('socks5h:', 'socks5:'));
  }
  browserProcess = spawn(executable, [
    `--user-data-dir=${profile}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
    '--disable-quic', '--disable-features=TrackingProtection3pcd,ThirdPartyCookieDeprecationTrial', '--window-size=1440,960', ...proxyArguments, 'https://example.com'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeLog = ''; browserProcess.stderr.on('data', chunk => { chromeLog = (chromeLog + chunk).slice(-4000); });
  let launchError;
  browserProcess.on('error', error => { launchError = error; });
  let endpoint;
  for (let i = 0; i < 150; i++) {
    if (launchError) throw launchError;
    try {
      const port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) { endpoint = `http://127.0.0.1:${port}`; break; }
    } catch {}
    if (browserProcess.exitCode !== null) throw new Error(`Chrome 启动失败：${chromeLog}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('Chrome 启动超时');
  await tools.connect(endpoint);
  chromeVersion = tools.browser.version();
  let worker;
  const context = tools.browser.contexts()[0];
  for (let i = 0; i < 100; i++) {
    for (const candidate of context.serviceWorkers().filter(w => w.url().startsWith('chrome-extension://'))) {
      try { if (await candidate.evaluate(() => chrome.runtime.getManifest().name === 'Obscura Desktop')) { worker = candidate; break; } } catch {}
    }
    if (worker) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!worker) throw new Error('Obscura 工作台扩展未加载');
  const extensionId = new URL(worker.url()).host;
  if (!options.testing) {
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  }
  const close = async () => {
    controller?.abort(); engine?.close(); transport.close();
    await downloads.close();
    await tools.browser?.close().catch(() => {});
    browserProcess.kill(); server.close();
  };
  browserProcess.on('exit', () => { controller?.abort(); engine?.close(); transport.close(); downloads.close().catch(() => {}); server.close(); });
  return { origin, token, extensionId, tools, settings, server, process: browserProcess, close, directory };
}
if (require.main === module) launch().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { launch };
