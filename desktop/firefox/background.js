/* Firefox persistent background page. Runs outside website JavaScript worlds. */
let bridgeSocket;
let reconnectTimer;
async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('请先打开一个 HTTP/HTTPS 网页标签');
  return tab;
}
async function execute(tabId, fn, args) {
  const [result] = await browser.tabs.executeScript(tabId, { code: `(${fn.toString()})(${JSON.stringify(args) ?? 'undefined'})` });
  return result;
}
function pageAction({ method, args }) {
  // Extension isolated-world state: references identify nodes, never list positions.
  const state = globalThis.__obscuraAutomationState ||= { document, ids: new WeakMap(), refs: new Map(), next: 0, epoch: `${Date.now()}${Math.floor(Math.random() * 1000000)}` };
  if (state.document !== document) throw new Error('页面文档已变化，请重新读取页面');
  const target = () => {
    const selector = args.ref && /^e\d+$/.test(args.ref) ? `[data-obscura-ref="${args.ref}"]` : args.selector;
    if (!selector) throw new Error('请提供 ref 或 CSS selector');
    const element = args.ref ? state.refs.get(args.ref) : document.querySelector(selector);
    if (!element || !element.isConnected) throw new Error('页面元素已变化，请重新读取页面');
    return element;
  };
  if (method === 'browser_upload') {
    const input = target();
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') throw new Error('目标不是文件上传控件');
    const file = args.file;
    const data = Uint8Array.from(atob(file.data), character => character.charCodeAt(0));
    if (data.length !== file.size) throw new Error('附件传输不完整');
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], file.name, { type: file.mime || 'application/octet-stream' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { uploaded: file.name, size: file.size };
  }
  if (method === 'browser_snapshot') {
    state.refs.clear();
    const controls = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="combobox"],[role="option"],[role="tab"],[contenteditable="true"],[aria-haspopup]')]
      .filter(el => el.getClientRects().length).slice(0, 180).map((el, i) => {
        let ref = state.ids.get(el);
        if (!ref) { ref = `e${state.epoch}${++state.next}`; state.ids.set(el, ref); }
        state.refs.set(ref, el);
        return { ref, tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') || [...(el.labels || [])].map(label => label.innerText).join(' ') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 180),
          type: el.getAttribute('type') || undefined,
          role: el.getAttribute('role') || undefined,
          expanded: el.getAttribute('aria-expanded') || undefined,
          haspopup: el.getAttribute('aria-haspopup') || undefined,
          selected: el.getAttribute('aria-selected') || undefined,
          checked: ['checkbox', 'radio'].includes(el.type) ? el.checked : el.getAttribute('aria-checked') || undefined,
          disabled: el.disabled === true,
          value: /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'password' ? String(el.value).slice(0, 1000) : undefined };
      });
    return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 18000), controls };
  }
  if (method === 'browser_click') {
    const el = target();
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('目标控件不可用');
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) throw new Error('目标不可见，请重新读取页面');
    const x = (left + right) / 2, y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== el && !el.contains(hit))) throw new Error('目标被其他元素遮挡，请重新读取页面');
    const evidence = JSON.stringify(pageAction({ method: 'browser_snapshot', args: {} }));
    const previous = state.lastClick;
    const count = previous?.element === el && previous.evidence === evidence ? previous.count + 1 : 1;
    if (count > 2) throw new Error('同一控件连续点击后页面未变化，已阻止重复点击；请检查菜单状态、等待异步结果或换用其他已观察到的控件');
    state.lastClick = { element: el, evidence, count };
    return { x, y, url: location.href };
  }
  if (method === 'browser_fill') {
    const el = target(); el.focus();
    if (el.isContentEditable) el.textContent = String(args.value);
    else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) throw new Error('目标不是可填写的字段');
      setter.call(el, String(args.value));
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'Filled';
  }
  if (method === 'browser_scroll') { scrollBy(0, Math.max(-10000, Math.min(10000, Number(args.y) || 0))); return 'Scrolled'; }
  throw new Error('Unsupported page operation');
}
async function command(method, args = {}, targetTabId) {
  if (method === 'browser_download_status') {
    const { downloads, folder } = await mediaBackend('list');
    for (const job of downloads.filter(job => job.kind === 'media')) await browser.obscuraNative.trackMediaDownload(JSON.stringify({ job, folder, bridge: BRIDGE }));
    return browser.downloads.search({});
  }
  if (method === 'target') {
    const tabs = await browser.tabs.query({});
    const tab = (Number.isInteger(args.tabId) && tabs.find(tab => tab.id === args.tabId)) || (args.url && tabs.find(tab => tab.url === args.url)) || await activeTab();
    return { id: tab.id, url: tab.url, title: tab.title };
  }
  if (method === 'browser_tabs') return (await browser.tabs.query({})).map(tab => ({ id: tab.id, windowId: tab.windowId, active: tab.active, title: tab.title, url: tab.url }));
  if (method === 'browser_select_tab') {
    const tab = await browser.tabs.update(args.tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return { id: tab.id, url: tab.url, title: tab.title };
  }
  if (method === 'browser_close_tab') { await browser.tabs.remove(args.tabId); return 'Closed'; }
  if (method === 'browser_new_tab') {
    const url = new URL(args.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP/HTTPS navigation is supported');
    const tab = await browser.tabs.create({ url: url.href });
    return { id: tab.id, url: url.href };
  }

  if (method === 'cookies') {
    const url = new URL(args.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported cookie URL');
    return browser.cookies.getAll({ url: url.href });
  }
  if (method === 'browser_navigate') {
    const url = new URL(args.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP/HTTPS navigation is supported');
    const current = Number.isInteger(targetTabId) ? await browser.tabs.get(targetTabId) : (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const tab = current || await browser.tabs.create({ url: 'about:blank' });
    let before;
    try { before = await execute(tab.id, () => ({ epoch: performance.timeOrigin, url: location.href })); } catch {}
    return new Promise((resolve, reject) => {
      let started = false;
      let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll); browser.tabs.onUpdated.removeListener(updated); browser.tabs.onRemoved.removeListener(removed); error ? reject(error) : resolve(value); };
      const updated = (id, change, value) => {
        if (id !== tab.id) return;
        if (change.status === 'loading') started = true;
        if (change.status === 'complete' && started && /^https?:/.test(value.url || '')) finish(null, { url: value.url, title: value.title });
      };
      const removed = id => { if (id === tab.id) finish(new Error('标签页已关闭')); };
      let probing = false;
      const probe = async () => {
        if (settled || probing) return;
        probing = true;
        try {
          const state = await execute(tab.id, () => ({ epoch: performance.timeOrigin, url: location.href, title: document.title, ready: document.readyState }));
          const newDocument = before && state.epoch !== before.epoch;
          const sameDocumentNavigation = before && before.url !== url.href && state.url === url.href;
          if ((newDocument || sameDocumentNavigation) && ['interactive', 'complete'].includes(state.ready)) finish(null, { url: state.url, title: state.title, ready: 'dom', needsSnapshot: true });
        } catch {} finally { probing = false; }
      };
      const poll = setInterval(probe, 250);
      // A slow subresource must not block the agent for nearly two minutes.
      // Pending is explicitly not navigation completion or task success.
      const timer = setTimeout(() => finish(null, { requestedURL: url.href, ready: 'pending', needsSnapshot: true, message: '页面仍在加载，请读取状态核实，不要重复刷新' }), 15000);
      browser.tabs.onUpdated.addListener(updated); browser.tabs.onRemoved.addListener(removed);
      const navigation = current?.url === url.href ? browser.tabs.reload(tab.id) : browser.tabs.update(tab.id, { url: url.href });
      navigation.then(() => browser.tabs.get(tab.id)).then(value => {
        if (started && value.status === 'complete' && /^https?:/.test(value.url || '')) finish(null, { url: value.url, title: value.title });
      }, error => finish(error));
    });
  }

  const requestedTab = args.tabId ?? targetTabId;
  const tab = Number.isInteger(requestedTab) ? await browser.tabs.get(requestedTab) : await activeTab();
  if (!/^https?:/.test(tab.url || '')) throw new Error('Only HTTP/HTTPS tabs support page operations');
  if (method === 'browser_stop') return browser.obscuraNative.stop(tab.id);
  if (method === 'browser_media') return { media: await listDetectedMedia(tab.id) };
  if (method === 'browser_press_key') return browser.obscuraNative.pressKey(tab.id, args.key);
  if (method === 'browser_screenshot') return browser.tabs.captureTab(tab.id, { format: 'png' });
  if (method === 'browser_evaluate') {
    const [result] = await browser.tabs.executeScript(tab.id, { code: args.expression });
    return result;
  }
  let result = await execute(tab.id, pageAction, { method, args });
  if (method === 'browser_click') result = await browser.obscuraNative.click(tab.id, result.x, result.y, result.url);
  if (['browser_click', 'browser_fill'].includes(method)) {
    try {
      // Observe the next rendered state without waiting for network idle.
      await execute(tab.id, () => new Promise(resolve => {
        const timer = setTimeout(resolve, 150);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
      }));
      return { action: result, snapshot: await execute(tab.id, pageAction, { method: 'browser_snapshot', args: {} }) };
    } catch (error) {
      // A click can navigate. Failure to observe must not replay its effect.
      return { action: result, observationError: String(error.message), needsSnapshot: true };
    }
  }
  return result;
}
async function connect() {
  clearTimeout(reconnectTimer);
  try {
    globalThis.BRIDGE = await browser.runtime.sendNativeMessage('ai.obscura.workspace', { type: 'bridge' });
    if (!BRIDGE?.origin || !BRIDGE?.token) throw new Error('Backend unavailable');
    // Do not advertise a ready automation connection before routing is applied.
    await applyProxy();
  } catch { reconnectTimer = setTimeout(connect, 1500); return; }
  const url = BRIDGE.origin.replace(/^http/, 'ws') + '/firefox-bridge?token=' + encodeURIComponent(BRIDGE.token);
  const socket = bridgeSocket = new WebSocket(url);
  socket.onmessage = async event => {
    let request;
    try { request = JSON.parse(event.data); } catch { return; }
    if (typeof request.id !== 'string' || typeof request.method !== 'string') return;
    let response;
    try { response = { id: request.id, result: await command(request.method, request.args, request.targetTabId) }; }
    catch (error) { response = { id: request.id, error: error.message }; }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  };
  socket.onclose = () => { if (bridgeSocket === socket) reconnectTimer = setTimeout(connect, 1500); };
  socket.onerror = () => socket.close();
}
browser.browserAction.onClicked.addListener(() => browser.sidebarAction.toggle());
browser.runtime.onMessage.addListener(message => {
  if (!['active-tab', 'x-login', 'reading-page', 'appearance', 'apply-proxy', 'open-login-log'].includes(message.type)) return false;
  return (async () => {
  if (message.type === 'active-tab') { const tab = await activeTab(); return { id: tab.id, url: tab.url, title: tab.title }; }
  if (message.type === 'x-login') return browser.tabs.create({ url: 'https://x.com/i/flow/login' });
  if (message.type === 'reading-page') {
    const tab = await browser.tabs.get(message.tabId);
    if (tab.url !== message.expectedURL) throw new Error('网页已跳转，请重新开始翻译');
    if (!['collect', 'apply', 'clear'].includes(message.action)) throw new Error('Unknown reading action');
    await browser.tabs.executeScript(tab.id, { file: 'reading-page.js' });
    return execute(tab.id, ({ action, translations }) => globalThis.__obscuraReading[action](translations), message);
  }
  if (message.type === 'appearance') {
    if (message.theme === 'system') await browser.theme.reset();
    else await browser.theme.update({ colors: message.theme === 'light' ? { frame: '#f0f0f4', toolbar: '#ffffff', tab_background_text: '#15141a', toolbar_text: '#15141a' } : { frame: '#1c1b22', toolbar: '#2b2a33', tab_background_text: '#fbfbfe', toolbar_text: '#fbfbfe' } });
    return { ok: true };
  }
  if (message.type === 'apply-proxy') { await applyProxy(); return { ok: true }; }
  if (message.type === 'open-login-log') {
    const response = await fetch(BRIDGE.origin + '/diagnostics/open', { method: 'POST', headers: { 'X-Obscura-Token': BRIDGE.token, 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('日志查看器打开失败');
    return response.json();
  }
  })();
});
connect();

async function localSettings(endpoint) {
  if (!BRIDGE?.origin) throw new Error('本地工作台尚未连接');
  const response = await fetch(BRIDGE.origin + endpoint, { headers: { 'X-Obscura-Token': BRIDGE.token } });
  if (!response.ok) throw new Error('本地网络配置读取失败');
  return response.json();
}
let proxyConfiguration;
let manualProxy;
function proxyRequest(details) {
  const host = new URL(details.url).hostname;
  if (['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return { type: 'direct' };
  const proxy = manualProxy;
  if (!proxy) throw new Error('Proxy configuration unavailable');
  const type = proxy.scheme === 'socks5' ? 'socks' : proxy.scheme;
  return { type, host: proxy.host, port: proxy.port, proxyDNS: type === 'socks',
    ...(['socks', 'socks4'].includes(type) ? { username: proxy.username || '', password: proxy.password || '' } : {}) };
}
async function applyProxy() {
  const config = await localSettings('/proxy-config');
  const auth = config.mode === 'fixed_servers' && config.rules.singleProxy.scheme.startsWith('socks') ? await localSettings('/proxy-auth') : null;
  const serialized = JSON.stringify({ config, auth });
  if (serialized === proxyConfiguration) return;
  if (config.mode === 'fixed_servers') {
    const proxy = config.rules.singleProxy;
    if (!['http', 'https', 'socks5', 'socks4'].includes(proxy.scheme)) throw new Error('不支持的代理类型');
    if (auth && (auth.host !== proxy.host || auth.port !== proxy.port)) throw new Error('代理配置正在变更，请稍候重试');
    manualProxy = { ...proxy, ...(auth ? { username: auth.username, password: auth.password } : {}) };
    if (!browser.proxy.onRequest.hasListener(proxyRequest)) browser.proxy.onRequest.addListener(proxyRequest, { urls: ['<all_urls>'] });
  } else {
    await browser.proxy.settings.set({ value: { proxyType: 'system' } });
    if (browser.proxy.onRequest.hasListener(proxyRequest)) browser.proxy.onRequest.removeListener(proxyRequest);
    manualProxy = null;
  }
  proxyConfiguration = serialized;
}
browser.webRequest.onAuthRequired.addListener(async details => {
  if (!details.isProxy) return {};
  const auth = await localSettings('/proxy-auth');
  if (auth.username && auth.host === details.challenger.host && auth.port === details.challenger.port) return { authCredentials: { username: auth.username, password: auth.password } };
  return {};
}, { urls: ['<all_urls>'] }, ['blocking']);
applyProxy().catch(() => {});
setInterval(() => applyProxy().catch(() => {}), 5000);

browser.contextMenus.create({ id: 'obscura-lookup', title: 'AI 查词并加入词典', contexts: ['selection'] });
browser.contextMenus.create({ id: 'obscura-search', title: '搜索所选文字', contexts: ['selection'] });
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'obscura-lookup') {
    browser.sidebarAction.open();
    (async () => {
      const selection = await execute(tab.id, () => {
        const selection = getSelection();
        const word = selection?.toString().trim().slice(0, 200) || '';
        const node = selection?.anchorNode?.parentElement;
        const paragraph = node?.closest('p,li,blockquote,td,dd') || node;
        const text = paragraph?.textContent || word;
        let context = text;
        try { context = [...new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: 'sentence' }).segment(text)].find(item => item.segment.includes(word))?.segment || text; } catch {}
        return { word, context: context.slice(0, 4000), sourceURL: location.href, sourceTitle: document.title };
      });
      await browser.storage.session.set({ lookupSelection: { ...selection, requestedAt: Date.now() } });
    })().catch(() => {});
  }
  if (info.menuItemId === 'obscura-search') {
    (async () => {
      const settings = await localSettings('/settings');
      const template = SEARCH_ENGINES[settings.searchEngine]?.template || SEARCH_ENGINES.google.template;
      await browser.tabs.create({ url: template.replace('{query}', encodeURIComponent(info.selectionText || '')) });
    })().catch(() => {});
  }
});

function authNetwork(details) {
  let url;
  try { url = new URL(details.url); } catch { return; }
  if (!['x.com', 'twitter.com', 'jf.x.com', 'accounts.google.com', 'grok.com', 'challenges.cloudflare.com'].includes(url.hostname)) return;
  if (bridgeSocket?.readyState !== WebSocket.OPEN) return;
  bridgeSocket.send(JSON.stringify({ event: 'auth-network', data: { url: url.origin + url.pathname, method: details.method, status: details.statusCode || 0, error: details.error || '', type: details.type } }));
}
browser.webRequest.onCompleted.addListener(authNetwork, { urls: ['<all_urls>'] });
browser.webRequest.onErrorOccurred.addListener(authNetwork, { urls: ['<all_urls>'] });

let nativePreferences;
async function syncNativePreferences() {
  const config = await localSettings('/settings');
  const key = JSON.stringify([config.searchEngine, config.authCompatibility]);
  if (nativePreferences === key) return;
  await browser.obscuraNative.setPrivacyCompatibility(config.authCompatibility === true);
  await browser.obscuraNative.setSearchEngine(config.searchEngine || 'google');
  nativePreferences = key;
}
setInterval(() => syncNativePreferences().catch(() => {}), 5000);

async function mediaBackend(action, args = {}) {
  const response = await fetch(BRIDGE.origin + '/downloads', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Obscura-Token': BRIDGE.token }, body: JSON.stringify({ action, ...args }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '下载服务不可用');
  return result;
}
async function startNativeDownload(args) {
  if (!args || !/^https?:\/\//i.test(args.url)) throw new Error('Invalid media URL');
  if (!args.media && !/\.(m3u8|mpd)(?:$|\?)/i.test(args.url)) {
    return { id: await browser.downloads.download({ url: args.url, saveAs: false }) };
  }
  const job = await mediaBackend('add', { args });
  const { folder } = await mediaBackend('list');
  await browser.obscuraNative.trackMediaDownload(JSON.stringify({ job, folder, bridge: BRIDGE }));
  return job;
}
browser.runtime.onMessage.addListener(message => {
  if (message.type === 'native-download') return startNativeDownload(message.args);
});
const mediaMenuId = 'obscura-download-media';
const mediaMenuTitle = browser.i18n.getUILanguage().startsWith('zh') ? '下载此媒体 · Obscura' : 'Download this media · Obscura';
browser.contextMenus.create({ id: mediaMenuId, title: mediaMenuTitle, contexts: ['all'], visible: false,
  documentUrlPatterns: ['*://x.com/*', '*://twitter.com/*', '*://*.youtube.com/*'] });
let mediaMenuGeneration = 0;
browser.contextMenus.onShown.addListener(async (info, tab) => {
  const generation = ++mediaMenuGeneration;
  let target;
  try { target = await browser.tabs.sendMessage(tab.id, { type: 'media-context-target' }, { frameId: info.frameId || 0 }); } catch {}
  if (generation !== mediaMenuGeneration) return;
  await browser.contextMenus.update(mediaMenuId, { visible: Boolean(target) });
  browser.contextMenus.refresh();
});
browser.contextMenus.onHidden.addListener(() => { mediaMenuGeneration++; });
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== mediaMenuId) return;
  try {
    const args = await browser.tabs.sendMessage(tab.id, { type: 'media-context-target' }, { frameId: info.frameId || 0 });
    await startNativeDownload(args);
    await browser.tabs.create({ url: 'about:downloads' });
  } catch (error) {
    await browser.tabs.create({ url: browser.runtime.getURL('download-error.html') + '?message=' + encodeURIComponent(error.message) });
  }
});
let syncingMediaDownloads = false;
setInterval(async () => {
  if (syncingMediaDownloads || !globalThis.BRIDGE?.token) return;
  syncingMediaDownloads = true;
  try {
    const { downloads, folder } = await mediaBackend('list');
    for (const job of downloads.filter(job => job.kind === 'media')) {
      await browser.obscuraNative.trackMediaDownload(JSON.stringify({ job, folder, bridge: BRIDGE }));
    }
  } catch (error) { console.warn('Media download synchronization:', error.message); }
  finally { syncingMediaDownloads = false; }
}, 2500);
