const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { NativeTools } = require(path.join(process.cwd(), 'native-tools.cjs'));
const { launch } = require(path.join(process.cwd(), 'app.cjs'));
const { relevant: isAuthDiagnosticURL } = require(path.join(process.cwd(), 'auth-diagnostics.cjs'));
const { oauthPopupHeaders, xLoginHeaders } = require(path.join(process.cwd(), 'oauth-popup.cjs'));
const { destination, searchURL } = require(path.join(process.cwd(), 'navigation.cjs'));
const { Bookmarks, bookmarkFile } = require(path.join(process.cwd(), 'bookmarks.cjs'));
const byId = id => document.getElementById(id);
const tabs = [];
let active, backend, closing = false;
let themePreference = 'dark';
const directory = process.env.OBSCURA_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/Obscura Desktop');
const bookmarks = new Bookmarks(path.join(directory, 'bookmarks.json'));
function recordCrash(kind, error) {
  try {
    const fsSync = require('node:fs');
    const file = path.join(directory, 'logs', 'crash.log');
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), kind, message: error?.message || String(error), stack: error?.stack || '' }) + '\n');
  } catch {}
}
process.on('uncaughtException', error => { recordCrash('uncaughtException', error); error(error.message); });
process.on('unhandledRejection', error => { recordCrash('unhandledRejection', error); error(error?.message || String(error)); });
let selection;
const nativeViews = new Map();
const tools = new NativeTools({ activeTarget: () => active?.targetId, onFullscreen: (targetId, enabled) => {
  const host = nativeViews.get(targetId);
  if (!host) return;
  host.view.ownerDocument.body.classList.toggle('media-fullscreen', enabled);
  host.window.obscuraMediaFullscreen = enabled;
  if (enabled) { host.window.focus(); host.window.enterFullscreen(); }
  else host.window.leaveFullscreen();
}, onSelection: (targetId, value) => {
  if (targetId !== active?.targetId) return;
  selection = value; byId('selection-word').textContent = value.word; byId('selection-box').hidden = false;
} });
const isWeb = value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };

function error(message) { byId('error').textContent = message; byId('error').hidden = !message; }
let challengePrivacy, challengeUntil = 0;
function noteChallenge() { challengeUntil = Date.now() + 180000; syncChallengePrivacy(); }
function syncChallengePrivacy() {
  const visible = tabs.some(tab => /Just a moment|Verifying you are human|正在进行安全验证/i.test(tab.title || '') || /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\//.test(tab.url || ''));
  const paused = visible || Date.now() < challengeUntil;
  if (paused === challengePrivacy) return;
  challengePrivacy = paused;
  chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: paused ? 'default' : 'disable_non_proxied_udp' }, () => {});
}
function selected() { return active?.view; }
function applyTheme(preference) {
  themePreference = preference;
  const resolved = preference === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : preference;
  document.documentElement.dataset.theme = resolved;
  byId('theme-toggle').textContent = resolved === 'dark' ? '☀' : '☾';
  byId('workbench').contentWindow?.postMessage({ type: 'obscura-theme', theme: preference }, location.origin);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePreference === 'system') applyTheme('system'); });
function renderTabs() {
  byId('tabs').replaceChildren(...tabs.map(tab => {
    const button = document.createElement('button');
    button.className = tab === active ? 'active' : '';
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab === active));
    const title = document.createElement('span'); title.className = 'tab-title'; title.textContent = tab.title || '新标签页';
    const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '×';
    close.onclick = event => { event.stopPropagation(); closeTab(tab); };
    button.append(title, close); button.onclick = () => activate(tab);
    return button;
  }));
}
function renderBookmarks() {
  const current = active?.url;
  byId('bookmark-toggle').textContent = bookmarks.has(current) ? '★' : '☆';
  byId('bookmark-list').replaceChildren(...bookmarks.items.map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.title || item.url;
    button.title = item.url + '\n点击打开，右键移除';
    button.onclick = () => navigate(item.url);
    button.oncontextmenu = event => { event.preventDefault(); bookmarks.remove(item.url).then(renderBookmarks).catch(reason => error(reason.message)); };
    return button;
  }));
}
async function toggleBookmark() {
  if (!isWeb(active?.url)) throw new Error('请先打开一个网页再收藏');
  await bookmarks.toggle(active.url, active.title);
  renderBookmarks();
}
function activate(tab) {
  active = tab;
  byId('selection-box').hidden = true;
  for (const item of tabs) item.view.classList.toggle('active', item === tab);
  byId('address').value = isWeb(tab.url) ? tab.url : '';
  renderTabs();
  renderBookmarks();
}
function closeTab(tab) {
  if (tabs.length === 1) { navigate('https://example.com'); return; }
  const index = tabs.indexOf(tab); tabs.splice(index, 1); tab.view.remove();
  nativeViews.delete(tab.targetId);
  const page = tools.pages.get(tab.targetId);
  if (page) { page.closed = true; page.detachDiagnostics?.(); page.client.close(); tools.pages.delete(tab.targetId); }
  if (active === tab) activate(tabs[Math.max(0, index - 1)]);
  renderTabs(); saveTabs();
}
async function saveTabs() {
  if (!backend) return;
  await fs.writeFile(path.join(directory, 'window-tabs.json'), JSON.stringify(tabs.map(tab => tab.url).filter(isWeb)), { mode: 0o600 });
}
async function applyProxy() {
  const response = await fetch(backend.origin + '/proxy-config', { headers: { 'X-Obscura-Token': backend.token } });
  const config = await response.json();
  await new Promise((resolve, reject) => chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve();
  }));
}
function authenticateProxy(details, callback) {
    if (!details.isProxy) { callback({}); return; }
    fetch(backend.origin + '/proxy-auth', { headers: { 'X-Obscura-Token': backend.token } }).then(response => response.json()).then(auth => {
      if (auth.username && auth.host === details.challenger.host && auth.port === details.challenger.port) callback({ authCredentials: { username: auth.username, password: auth.password } });
      else callback({});
    }).catch(() => callback({}));
}
function configureRequests(view, { oauthPopup = false } = {}) {
  view.request.onHeadersReceived.addListener(details => {
    const mitigated = details.responseHeaders?.find(header => header.name.toLowerCase() === 'cf-mitigated')?.value;
    if (details.type === 'main_frame' && mitigated === 'challenge') noteChallenge();
  }, { urls: ['<all_urls>'] }, ['responseHeaders']);
  view.request.onHeadersReceived.addListener(details => {
    const result = xLoginHeaders(details, tools.authCompatibility);
    const policy = details.responseHeaders?.find(header => header.name.toLowerCase() === 'cross-origin-opener-policy')?.value;
    backend?.diagnostics.record('x.coop', { url: details.url, originalPolicy: policy, removed: !!result.responseHeaders && !!policy });
    return result;
  }, { urls: ['https://x.com/*', 'https://*.x.com/*'], types: ['main_frame'] }, ['blocking', 'responseHeaders']);
  if (oauthPopup) view.request.onHeadersReceived.addListener(details => {
    const policy = details.responseHeaders?.find(header => header.name.toLowerCase() === 'cross-origin-opener-policy')?.value;
    backend?.diagnostics.record('popup.coop', { url: details.url, originalPolicy: policy, removed: !!policy });
    return oauthPopupHeaders(details);
  }, { urls: ['https://accounts.google.com/*', 'https://appleid.apple.com/*', 'https://idmsa.apple.com/*'], types: ['main_frame'] }, ['blocking', 'responseHeaders']);
  view.request.onBeforeRedirect.addListener(details => {
    if (isAuthDiagnosticURL(details.url) || isAuthDiagnosticURL(details.redirectUrl)) backend?.diagnostics.record('webview.redirect', { request: backend.diagnostics.id(details.requestId), url: details.url, destination: details.redirectUrl, status: details.statusCode });
  }, { urls: ['<all_urls>'] });
  view.request.onCompleted.addListener(details => {
    if (isAuthDiagnosticURL(details.url)) backend?.diagnostics.record('webview.response', { request: backend.diagnostics.id(details.requestId), url: details.url, status: details.statusCode, type: details.type });
  }, { urls: ['<all_urls>'] });
  view.request.onErrorOccurred.addListener(details => {
    if (isAuthDiagnosticURL(details.url)) backend?.diagnostics.record('webview.failed', { request: backend.diagnostics.id(details.requestId), url: details.url, error: details.error, preparation: view.obscuraStagedRequests?.has(details.requestId) === true });
    view.obscuraStagedRequests?.delete(details.requestId);
  }, { urls: ['<all_urls>'] });
  view.request.onBeforeRequest.addListener(details => {
    if (isAuthDiagnosticURL(details.url)) backend?.diagnostics.record('webview.request', { request: backend.diagnostics.id(details.requestId), url: details.url, method: details.method, type: details.type });
    if (/^(file|chrome-extension):/i.test(details.url)) return { cancel: true };
    if (details.type === 'main_frame' && !isWeb(details.url) && !details.url.startsWith('about:blank')) return { cancel: true };
    return {};
  }, { urls: ['<all_urls>'] }, ['blocking']);
  view.request.onAuthRequired.addListener(authenticateProxy, { urls: ['<all_urls>'] }, ['asyncBlocking']);
}
function isLoginURL(value) {
  try {
    const url = new URL(value);
    return ['accounts.google.com', 'accounts.youtube.com', 'appleid.apple.com'].includes(url.hostname) ||
      (/(^|\.)youtube\.com$/.test(url.hostname) && /^\/(signin|check|accounts?)(?:\/|$)/.test(url.pathname)) ||
      (/(^|\.)x\.com$/.test(url.hostname) && /\/(?:i\/(?:flow|jf)|oauth|login|signin)/.test(url.pathname));
  } catch { return value === 'about:blank'; }
}
function handleNewWindow(event, openerId) {
  backend?.diagnostics.record('popup.request', { opener: backend.diagnostics.id(openerId), url: event.targetUrl, hasWindow: !!event.window, nativePopup: isLoginURL(event.targetUrl) || event.targetUrl === 'about:blank' });
  event.preventDefault();
  if (!isWeb(event.targetUrl) && event.targetUrl !== 'about:blank') { event.window.discard(); return; }
  if (isLoginURL(event.targetUrl) || event.targetUrl === 'about:blank') {
    createPopup(event.window, openerId, event.targetUrl).catch(reason => error(reason.message));
  } else {
    try { event.window?.discard(); } catch {}
    createTab(event.targetUrl).catch(reason => error(reason.message));
  }
}
function configurePermissions(view, window) {
  view.addEventListener('permissionrequest', event => {
    if (event.permission === 'fullscreen') {
      event.request.deny();
      view.executeScript({ code: `if(document.fullscreenElement)document.exitFullscreen();else{const video=[...document.querySelectorAll('video')].find(item=>!item.paused)||document.querySelector('video');video?.requestFullscreen()}`, mainWorld: true }, () => {});
      return;
    }
    if (event.permission === 'download') { event.request.allow(); return; }
    event.request.deny();
  });
  if (window.obscuraFullscreenViews) { window.obscuraFullscreenViews.add(view); return; }
  window.obscuraFullscreenViews = new Set([view]);
  window.on('enter-fullscreen', () => {
    if (window.obscuraMediaFullscreen === false) window.leaveFullscreen();
  });
  window.on('leave-fullscreen', () => {
    window.obscuraMediaFullscreen = undefined;
    for (const item of window.obscuraFullscreenViews) {
      if (!item.isConnected) { window.obscuraFullscreenViews.delete(item); continue; }
      item.ownerDocument.body.classList.remove('media-fullscreen');
      const host = [...nativeViews.entries()].find(([, value]) => value.view === item);
      const page = host && tools.pages.get(host[0]);
      page?.evaluate('if(document.fullscreenElement)document.exitFullscreen()').catch(() => {});
    }
  });
}
async function createPopup(popup, openerId, initialURL = 'about:blank') {
  return new Promise((resolve, reject) => {
    nw.Window.open(new URL('popup.html', location.href).href, { title: '登录', width: 600, height: 800, position: 'center' }, win => {
      win.on('loaded', async () => {
        try {
          const doc = win.window.document;
          doc.documentElement.dataset.theme = document.documentElement.dataset.theme;
          const view = doc.createElement('webview');
          const marker = 'obscura-popup-' + crypto.randomUUID();
          let privacyReady = false, pendingURL = isWeb(initialURL) ? initialURL : null, unsupportedInitialMethod = false;
          view.obscuraStagedRequests = new Set();
          view.setAttribute('partition', 'persist:obscura');
          doc.body.append(view);
          view.request.onBeforeRequest.addListener(details => {
            if (privacyReady || details.type !== 'main_frame' || !isWeb(details.url)) return {};
            view.obscuraStagedRequests.add(details.requestId);
            if (details.method !== 'GET') unsupportedInitialMethod = true;
            else if (!pendingURL || details.url !== pendingURL.split('#')[0]) pendingURL = details.url;
            return { cancel: true };
          }, { urls: ['<all_urls>'] }, ['blocking']);
          configureRequests(view, { oauthPopup: true });
          view.addEventListener('close', () => win.close(true));
          configurePermissions(view, win);
          view.addEventListener('newwindow', event => handleNewWindow(event, popupTargetId || openerId));
          let promoted = false, popupTargetId;
          view.addEventListener('loadcommit', event => {
            if (!event.isTopLevel || promoted || !isWeb(event.url) || isLoginURL(event.url)) return;
            const host = new URL(event.url).hostname;
            if (!/(^|\.)(youtube\.com|mail\.google\.com)$/.test(host)) return;
            promoted = true;
            createTab(event.url).then(() => { nw.Window.get().show(); nw.Window.get().focus(); win.close(true); }).catch(reason => { promoted = false; error(reason.message); });
          });
          popup.attach(view);
          view.stop();
          view.src = 'about:blank#' + marker;
          backend.diagnostics.record('popup.attached', { opener: backend.diagnostics.id(openerId), staged: true, url: pendingURL });
          const targetId = await tools.prepareGuest(marker, openerId);
          popupTargetId = targetId;
          if (unsupportedInitialMethod) throw new Error('该登录弹窗的初始请求无法安全暂存，请从网页登录入口重试');
          privacyReady = true;
          backend.diagnostics.record('popup.privacy.ready', { target: backend.diagnostics.id(targetId), url: pendingURL });
          if (pendingURL) view.src = pendingURL;
          nativeViews.set(targetId, { view, window: win });
          win.on('closed', () => {
            nativeViews.delete(targetId);
            const page = tools.pages.get(targetId);
            if (page) { page.closed = true; page.detachDiagnostics?.(); page.client.close(); tools.pages.delete(targetId); }
          });
          resolve({ targetId, view });
        } catch (reason) { backend.diagnostics.record('popup.failed', { message: reason.message }); win.close(true); reject(reason); }
      });
    });
  });
}
async function createTab(url = 'https://example.com') {
  const id = 'obscura-' + crypto.randomUUID();
  const view = document.createElement('webview');
  view.setAttribute('partition', 'persist:obscura');
  view.setAttribute('src', 'about:blank#' + id);
  const tab = { id, view, url: 'about:blank', title: '新标签页' };
  tabs.push(tab);
  byId('pages').append(view); activate(tab);
  configurePermissions(view, nw.Window.get());
  view.addEventListener('newwindow', event => handleNewWindow(event, tab.targetId));
  view.addEventListener('close', () => closeTab(tab));
  configureRequests(view);
  view.addEventListener('loadcommit', event => {
    if (!event.isTopLevel) return;
    tab.url = event.url;
    if (active === tab && document.activeElement !== byId('address')) byId('address').value = isWeb(tab.url) ? tab.url : '';
    if (active === tab) renderBookmarks();
    saveTabs().catch(() => {});
  });
  view.addEventListener('loadstart', () => { if (active === tab) byId('page-status').textContent = '正在加载…'; });
  view.addEventListener('loadstop', async () => {
    const page = tools.pages.get(tab.targetId);
    if (page) tab.title = await page.title().catch(() => tab.url);
    renderTabs();
    if (/Just a moment|Verifying you are human|正在进行安全验证/i.test(tab.title || '')) noteChallenge();
    else syncChallengePrivacy();
    if (active === tab) renderBookmarks();
    if (active === tab) byId('page-status').textContent = '就绪';
  });
  view.addEventListener('loadabort', event => { if (event.reason !== 'ERR_ABORTED') error('网页加载失败 ' + event.reason); });
  tab.targetId = await tools.prepareGuest(id);
  nativeViews.set(tab.targetId, { view, window: nw.Window.get() });
  if (isWeb(url)) view.src = url;
  return tab;
}
async function navigate(value) {
  try {
    const config = await backend.settings.read();
    const url = destination(value, config.searchEngine);
    error('');
    if (!selected()) await createTab(url);
    else selected().src = url;
  } catch (reason) { error(reason.message); }
}
function openPanel(section) {
  byId('panel-container').hidden = false;
  if (section) {
    const button = byId('workbench').contentDocument?.querySelector(`[data-tab="${section}"]`);
    button?.click();
  }
}
async function start() {
  const port = process.env.OBSCURA_DEBUG_PORT;
  if (!port) throw new Error('独立应用调试通道未初始化，请使用应用启动入口');
  backend = await launch({ directory, browserTools: tools, browserEndpoint: 'http://127.0.0.1:' + port });
  if (!backend) { nw.Window.get().close(true); return; }
  await bookmarks.load();
  renderBookmarks();
  await applyProxy();
  applyTheme((await backend.settings.read()).theme || 'dark');
  globalThis.obscuraHost = {
    standalone: true,
    bridge: { origin: backend.origin, token: backend.token },
    openTab: async url => { await createTab(url); },
    openPanel: async () => { byId('panel-container').hidden = true; },
    message: async data => {
      if (data.type === 'open-login-log') { const state = await backend.diagnostics.flush(); if (state.writeError) throw new Error(state.writeError); nw.Shell.showItemInFolder(state.file); return { ok: true }; }
      if (data.type === 'x-login') {
        const tab = tabs.find(item => /^https:\/\/x\.com\//.test(item.url)) || await createTab('about:blank');
        activate(tab);
        tab.view.src = 'https://x.com/i/flow/login';
        return { ok: true };
      }
      if (data.type === 'reading-page') {
        const page = tools.pages.get(data.tabId);
        if (!page || !['collect', 'apply', 'clear'].includes(data.action)) throw new Error('原网页已关闭');
        if (page.url() !== data.expectedURL) throw new Error('原网页已跳转，请重新开始翻译');
        return page.evaluate(({ action, translations }) => globalThis.__obscuraReading[action](translations), { action: data.action, translations: data.translations });
      }
      if (data.type === 'active-tab') return active ? { id: active.targetId, url: active.url, title: active.title } : {};
      if (data.type === 'media-list') return { media: tools.media.get(data.tabId) || [] };
      if (data.type === 'apply-proxy') { await applyProxy(); return { ok: true }; }
      if (data.type === 'appearance') { applyTheme(data.theme); return { ok: true }; }
      return {};
    }
  };
  byId('workbench').src = '../extension/panel.html';
  let urls = [];
  try { urls = JSON.parse(await fs.readFile(path.join(directory, 'window-tabs.json'), 'utf8')); } catch {}
  for (const url of urls.filter(isWeb)) await createTab(url);
  if (!tabs.length) await createTab();
  byId('runtime').textContent = `Obscura ${nw.App.manifest.version} · Chromium ${process.versions.chromium} · NW.js ${process.versions.nw}`;
  byId('page-status').textContent = '就绪';

  const menu = new nw.Menu({ type: 'menubar' }); menu.createMacBuiltin('Obscura Desktop'); nw.Window.get().menu = menu;
  nw.App.on('reopen', () => { nw.Window.get().show(); nw.Window.get().focus(); });
}
byId('address-bar').onsubmit = event => { event.preventDefault(); navigate(byId('address').value); };
byId('bookmark-toggle').onclick = () => toggleBookmark().catch(reason => error(reason.message));
byId('bookmark-export').onclick = async () => {
  const file = path.join(directory, 'bookmarks.html');
  await fs.writeFile(file, bookmarkFile(bookmarks.items));
  nw.Shell.showItemInFolder(file);
};
byId('bookmark-import').onclick = () => byId('bookmark-file').click();
byId('bookmark-file').onchange = async () => {
  const file = byId('bookmark-file').files?.[0];
  byId('bookmark-file').value = '';
  if (!file) return;
  try { await bookmarks.importFile(await file.text()); renderBookmarks(); }
  catch (reason) { error(reason.message); }
};
byId('back').onclick = () => selected()?.back();
byId('forward').onclick = () => selected()?.forward();
byId('reload').onclick = () => selected()?.reload();
byId('new-tab').onclick = () => createTab().catch(reason => error(reason.message));
byId('toggle-panel').onclick = () => { byId('panel-container').hidden = !byId('panel-container').hidden; };
byId('open-reading').onclick = () => openPanel('reading');
byId('search-selection').onclick = async () => {
  if (!selection?.word) return;
  const query = selection.word;
  byId('selection-box').hidden = true;
  try { const config = await backend.settings.read(); await createTab(searchURL(query, config.searchEngine)); }
  catch (reason) { error(reason.message); }
};
byId('lookup-selection').onclick = () => {
  openPanel('reading');
  byId('workbench').contentWindow.postMessage({ type: 'obscura-lookup', selection }, location.origin);
  byId('selection-box').hidden = true;
};
byId('dismiss-selection').onclick = () => { byId('selection-box').hidden = true; };
byId('open-downloads').onclick = () => openPanel('downloads');
byId('open-settings').onclick = () => openPanel('settings');
byId('theme-toggle').onclick = async () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { await backend.settings.save({ theme }); applyTheme(theme); }
  catch (reason) { error(reason.message); }
};
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'l') { event.preventDefault(); byId('address').focus(); byId('address').select(); }
  if ((event.metaKey || event.ctrlKey) && event.key === 't') { event.preventDefault(); createTab().catch(reason => error(reason.message)); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); toggleBookmark().catch(reason => error(reason.message)); }
});
nw.Window.get().on('close', async function () {
  if (closing) return;
  closing = true; this.hide();
  await saveTabs().catch(() => {});
  await backend?.close('main-window-close').catch(() => {});
  this.close(true);
});
start().catch(reason => error(reason.stack || reason.message));
