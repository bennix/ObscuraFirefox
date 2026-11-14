const fs = require('node:fs/promises');
const path = require('node:path');
const { CDP } = require('./cdp.cjs');
const { ChromeTools, definitions } = require('./chrome-tools.cjs');
const { chromeClientHints } = require('./chrome-client.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function challengeTarget(url = '') {
  return /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\//.test(url);
}

async function applyChromeBrand(client, session) {
  try {
    const probed = await client.send('Runtime.evaluate', {
      expression: `(async()=>{const data=navigator.userAgentData;const hints=data?await data.getHighEntropyValues(['fullVersionList','platform','platformVersion','architecture','bitness','model','wow64']):{};const full=(hints.fullVersionList||[]).find(item=>item.brand==='Chromium')?.version||'';return {ua:navigator.userAgent,mobile:data?.mobile===true,brands:(data?.brands||[]).map(item=>({brand:item.brand,version:item.version})),fullVersion:full,platformName:hints.platform||'',platformVersion:hints.platformVersion||'',architecture:hints.architecture||'',bitness:hints.bitness||'',model:hints.model||'',wow64:hints.wow64===true};})()`,
      awaitPromise: true, returnByValue: true
    }, session);
    const override = chromeClientHints(probed.result?.value);
    if (override) await client.send('Network.setUserAgentOverride', override, session);
  } catch {}
}

class NativePage {
  constructor(target, client) { this.id = target.id; this.currentURL = target.url; this.client = client; this.closed = false; }
  url() { return this.currentURL; }
  isClosed() { return this.closed; }
  async evaluate(fn, argument, userGesture = false) {
    const expression = typeof fn === 'function' ? `(${fn.toString()})(${JSON.stringify(argument) ?? ''})` : fn;
    const response = await this.client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  title() { return this.evaluate(() => document.title); }
  async goto(url, { timeout = 45000 } = {}) {
    const result = await this.client.send('Page.navigate', { url });
    if (result.errorText) throw new Error(result.errorText);
    this.currentURL = url;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate(() => ({ url: location.href, ready: document.readyState }));
        const tree = await this.client.send('Page.getFrameTree');
        if (tree.frameTree.frame.loaderId === result.loaderId && ['interactive', 'complete'].includes(state.ready)) {
          this.currentURL = state.url; return null;
        }
      } catch {}
      await delay(100);
    }
    throw new Error('网页加载超时');
  }
}

class NativeTools extends ChromeTools {
  constructor(host) {
    super(); this.host = host; this.pages = new Map(); this.media = new Map();
  }

  async connect(endpoint) {
    this.endpoint = endpoint;
    const privacy = await fs.readFile(path.join(__dirname, 'extension/privacy.js'), 'utf8');
    const imageViewer = await fs.readFile(path.join(__dirname, 'extension/image-viewer.js'), 'utf8');
    const fullscreen = await fs.readFile(path.join(__dirname, 'extension/media-fullscreen.js'), 'utf8');
    const youtubeAds = await fs.readFile(path.join(__dirname, 'extension/youtube-ads.js'), 'utf8');
    const reading = await fs.readFile(path.join(__dirname, 'extension/reading-page.js'), 'utf8');
    this.authTrace = await fs.readFile(path.join(__dirname, 'extension/auth-trace.js'), 'utf8');
    this.diagnosticTargets = new Map();
    const flag = (name, on) => on ? `Object.defineProperty(globalThis,"${name}",{value:true});` : '';
    // googleLogin is the popup-scoped relaxation; privacy.js only honors it on accounts.google.com.
    this.build = googleLogin => {
      const flags = `${flag('__obscuraAuthCompatibility', this.authCompatibility)}${flag('__obscuraGoogleLoginCompatibility', googleLogin)}`;
      return {
        privacySource: `${flags}\n${privacy}`,
        source: `(() => { const key = Symbol.for('obscura.native.initialized'); if (globalThis[key]) return; Object.defineProperty(globalThis, key, {value:true});\n${flags}\n${privacy}\nif (['accounts.google.com','accounts.youtube.com'].includes(location.hostname)) return;\n${imageViewer}\n${reading}\n${youtubeAds}\n${fullscreen}\n})();`
      };
    };
    Object.assign(this, this.build(false));
    this.initializingTargets = new Map();
    this.closing = false;
    await this.connectBrowser();
  }

  // The browser-level socket can drop (for example across system sleep) while the guests and
  // their own page sockets stay usable, so it is re-established without touching either.
  async connectBrowser() {
    const version = await (await fetch(this.endpoint + '/json/version', { signal: AbortSignal.timeout(5000) })).json();
    const client = await CDP.connect(version.webSocketDebuggerUrl);
    client.on('Target.targetDestroyed', event => this.initializingTargets.delete(event.targetId));
    try { await client.send('Target.setDiscoverTargets', { discover: true }); }
    catch (error) { client.close(); throw error; }
    this.browserClient = client;
    client.onClose(() => {
      if (this.browserClient !== client || this.closing) return;
      this.diagnostics?.record('browser.disconnected', {});
      this.reconnectBrowser().catch(() => {});
    });
    return client;
  }

  // Concurrent callers share one reconnect loop. Resolves once connected, rejects after the retries run out.
  reconnectBrowser({ attempts = this.reconnectAttempts ?? 40, interval = this.reconnectInterval ?? 500 } = {}) {
    if (this.browserClient?.open) return Promise.resolve(this.browserClient);
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      let lastError;
      for (let attempt = 0; attempt < attempts && !this.closing; attempt++) {
        try {
          const client = await this.connectBrowser();
          this.diagnostics?.record('browser.reconnected', { attempts: attempt + 1 });
          return client;
        } catch (error) { lastError = error; }
        await delay(interval);
      }
      this.diagnostics?.record('browser.reconnect.failed', { message: lastError?.message });
      this.onBrowserLost?.(lastError);
      throw lastError || new Error('浏览器连接已关闭');
    })().finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }

  async browserSend(method, params) {
    const client = this.browserClient?.open ? this.browserClient : await this.reconnectBrowser({ attempts: 3, interval: 200 });
    return client.send(method, params);
  }

  // Temporary Google login relaxation: only a popup opened from X (or from such a popup), and only while X compatibility is on.
  // privacy.js additionally limits the effect to accounts.google.com documents, so it ends on navigation away.
  // Native WebRTC constructors stay available there; non-proxied UDP remains disabled by the process policy.
  googleLoginAllowed(openerId) {
    if (this.authCompatibility !== true) return false;
    const opener = this.pages.get(openerId);
    if (!opener) return false;
    if (opener.googleLoginCompat) return true;
    try { return /(^|\.)x\.com$/.test(new URL(opener.url()).hostname); } catch { return false; }
  }

  async initializeTarget(client, event, sources = this) {
    const session = event.sessionId;
    let ready = false;
    const watchdog = setTimeout(() => {
      if (ready) return;
      this.diagnostics?.record('target.protection.timeout', { target: this.diagnostics.id(event.targetInfo.targetId) });
      this.browserSend('Target.closeTarget', { targetId: event.targetInfo.targetId }).catch(() => {});
    }, 5000);
    try {
      const challenge = challengeTarget(event.targetInfo.url);
      if (!challenge) await client.send('Page.addScriptToEvaluateOnNewDocument', { source: sources.source }, session);
      if (this.diagnostics) {
        const detach = this.diagnostics.attach(client, { ...event.targetInfo, waitingForDebugger: event.waitingForDebugger }, session);
        this.diagnosticTargets.set(session, detach);
        if (!challenge) {
          await client.send('Runtime.addBinding', { name: 'obscuraAuthEvent' }, session);
          await client.send('Page.addScriptToEvaluateOnNewDocument', { source: this.authTrace }, session);
        }
      }
      if (!challenge) {
        await client.send('Runtime.addBinding', { name: 'obscuraSelection' }, session);
        await client.send('Runtime.addBinding', { name: 'obscuraFullscreen' }, session);
      }
      await Promise.all([client.send('Network.enable', { maxTotalBufferSize: 2097152, maxResourceBufferSize: 262144 }, session), client.send('Runtime.enable', {}, session), client.send('Page.enable', {}, session)]);
      await applyChromeBrand(client, session);
      if (event.waitingForDebugger && !challenge) await client.send('Runtime.evaluate', { expression: sources.privacySource }, session);
      ready = true;
      await client.send('Runtime.runIfWaitingForDebugger', {}, session);
      this.diagnostics?.record('target.protected', { target: this.diagnostics.id(event.targetInfo.targetId), type: event.targetInfo.type });
    } catch (error) {
      await this.browserSend('Target.closeTarget', { targetId: event.targetInfo.targetId }).catch(() => {});
      throw error;
    } finally { clearTimeout(watchdog); }
  }

  async prepareGuest(marker, openerId) {
    let target;
    for (let attempt = 0; attempt < 100; attempt++) {
      const targets = await (await fetch(this.endpoint + '/json/list', { signal: AbortSignal.timeout(5000) })).json();
      // A marker identifies its guest exactly; opener metadata is only needed to pick an unmarked guest.
      if (!marker && openerId) {
        const metadata = await this.browserSend('Target.getTargets');
        for (const item of targets) item.openerId = metadata.targetInfos.find(info => info.targetId === item.id)?.openerId;
      }
      target = targets.find(item => item.type === 'webview' && (marker ? item.url.includes(marker) : !this.pages.has(item.id) && (!openerId || item.openerId === openerId)));
      if (target) break;
      await delay(50);
    }
    if (!target) { this.diagnostics?.record('guest.prepare.failed', { opener: this.diagnostics.id(openerId), markerPresent: !!marker }); throw new Error('内置网页视图未就绪'); }
    if (this.initializingTargets.has(target.id)) await this.initializingTargets.get(target.id);
    const googleLogin = !!openerId && this.googleLoginAllowed(openerId);
    const sources = googleLogin ? this.build(true) : this;
    const client = await CDP.connect(target.webSocketDebuggerUrl);
    const page = new NativePage(target, client);
    page.googleLoginCompat = googleLogin;
    if (googleLogin) this.diagnostics?.record('guest.google-login-compat', { target: this.diagnostics.id(target.id) });
    this.pages.set(target.id, page);
    if (this.diagnostics) page.detachDiagnostics = this.diagnostics.attach(client, target);
    client.on('Target.attachedToTarget', event => {
      const initialization = this.initializeTarget(client, event, sources);
      this.initializingTargets.set(event.targetInfo.targetId, initialization);
      initialization.catch(error => this.diagnostics?.record('target.initialization.error', { target: this.diagnostics.id(event.targetInfo.targetId), message: error.message }));
    });
    client.on('Target.detachedFromTarget', event => { this.diagnosticTargets.get(event.sessionId)?.(); this.diagnosticTargets.delete(event.sessionId); });
    await client.send('Runtime.enable');
    if (this.diagnostics) await client.send('Runtime.addBinding', { name: 'obscuraAuthEvent' });
    await client.send('Runtime.addBinding', { name: 'obscuraSelection' });
    await client.send('Runtime.addBinding', { name: 'obscuraFullscreen' });
    client.on('Runtime.bindingCalled', async event => {
      if (event.name === 'obscuraFullscreen') {
        try {
          const value = JSON.parse(event.payload);
          if (typeof value.enabled !== 'boolean') return;
          if (value.enabled) {
            const activation = await client.send('Runtime.evaluate', { expression: 'navigator.userActivation.isActive', returnByValue: true, userGesture: false });
            if (!activation.result.value) return;
          }
          this.host.onFullscreen?.(page.id, value.enabled);
        } catch {}
        return;
      }
      if (event.name !== 'obscuraSelection') return;
      try {
        const selection = JSON.parse(event.payload);
        if (typeof selection.word === 'string' && selection.word.length <= 200) this.host.onSelection?.(page.id, selection);
      } catch {}
    });
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: sources.source });
    if (this.diagnostics) await client.send('Page.addScriptToEvaluateOnNewDocument', { source: this.authTrace });
    await client.send('Runtime.evaluate', { expression: sources.source });
    if (this.diagnostics) await client.send('Runtime.evaluate', { expression: this.authTrace });
    await client.send('Runtime.runIfWaitingForDebugger');
    await client.send('Page.enable');
    await client.send('Network.enable');
    await applyChromeBrand(client);
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }, { type: 'webview', exclude: false }, { exclude: true }] });
    client.on('Page.frameNavigated', event => {
      if (!event.frame.parentId) { page.currentURL = event.frame.url; this.media.set(page.id, []); }
    });
    client.on('Network.responseReceived', event => this.recordMedia(page, event));
    this.diagnostics?.record('guest.prepared', { target: this.diagnostics.id(target.id), opener: this.diagnostics.id(openerId), url: target.url });
    return target.id;
  }

  recordMedia(page, event) {
    const response = event.response;
    if (response.status >= 400 || !/^https?:/.test(response.url)) return;
    if (/\.(ts|m4s)(?:$|\?)/i.test(response.url) || /mp2t/i.test(response.mimeType)) return;
    let kind;
    if (/mpegurl/i.test(response.mimeType) || /\.m3u8(?:$|\?)/i.test(response.url)) kind = 'HLS';
    else if (/dash\+xml/i.test(response.mimeType) || /\.mpd(?:$|\?)/i.test(response.url)) kind = 'DASH';
    else if (/^(video|audio)\//i.test(response.mimeType)) kind = response.mimeType.startsWith('audio') ? '音频' : '视频';
    if (!kind) return;
    const list = this.media.get(page.id) || [];
    const url = new URL(response.url);
    const source = new URL(page.url());
    const youtube = /(^|\.)googlevideo\.com$/.test(url.hostname) && /(^|\.)youtube\.com$/.test(source.hostname);
    const track = youtube ? url.searchParams.get('itag') : null;
    const key = track ? `${page.url()}#${track}` : response.url;
    if (list.some(item => item.key === key)) return;
    const length = response.headers['content-length'] || response.headers['Content-Length'];
    list.unshift({ key, url: response.url, downloadUrl: youtube ? page.url() : response.url,
      format: track ? kind === '音频' ? track : `${track}+bestaudio/${track}` : undefined,
      kind, host: url.hostname, title: url.pathname.split('/').pop() || url.hostname,
      size: ['HLS', 'DASH'].includes(kind) ? null : Number(url.searchParams.get('clen') || length) || null });
    this.media.set(page.id, list.slice(0, 100));
  }

  async page() {
    if (this.currentPage && !this.currentPage.closed) return this.currentPage;
    const id = this.host.activeTarget();
    const page = this.pages.get(id);
    if (!page) throw new Error('请先打开一个网页');
    return page;
  }

  async cookies(url) {
    const page = await this.page();
    return (await page.client.send('Network.getCookies', { urls: [url] })).cookies;
  }

  async stop() {
    const page = await this.page().catch(() => null);
    if (page) await Promise.allSettled([page.client.send('Runtime.terminateExecution'), page.client.send('Page.stopLoading')]);
  }

  async call(name, args = {}) {
    this.signal?.throwIfAborted();
    if (!definitions.some(tool => tool.name === name)) throw new Error('Unknown browser tool');
    const page = await this.page();
    const client = page.client;
    let result;
    if (name === 'browser_navigate') {
      if (!/^https?:\/\//i.test(args.url)) throw new Error('请输入 HTTP 或 HTTPS 地址');
      result = await this.navigate(page, args.url);
    } else if (name === 'browser_snapshot') {
      result = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
          .filter(element => element.getBoundingClientRect().width && element.getBoundingClientRect().height).slice(0, 180)
          .map((element, index) => {
            const ref = `e${index + 1}`; element.setAttribute('data-obscura-ref', ref);
            return { ref, tag: element.tagName.toLowerCase(), label: (element.getAttribute('aria-label') || element.innerText || element.getAttribute('placeholder') || '').slice(0, 180) };
          });
        return { title: document.title, url: location.href, text: document.body.innerText.slice(0, 18000), controls };
      });
    } else if (name === 'browser_click' || name === 'browser_fill') {
      const selector = /^e\d+$/.test(args.ref || '') ? `[data-obscura-ref="${args.ref}"]` : args.selector;
      if (!selector) throw new Error('请提供元素引用或选择器');
      await page.evaluate(selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('未找到元素');
        element.scrollIntoView({ block: 'center' }); element.focus();
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, selector);
      if (name === 'browser_click') {
        await page.evaluate(selector => document.querySelector(selector).click(), selector, true);
      } else {
        await page.evaluate(({ selector, value }) => {
          const element = document.querySelector(selector);
          const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }, { selector, value: String(args.value) });
      }
      result = '完成';
    } else if (name === 'browser_evaluate') result = await page.evaluate(args.expression, undefined, true);
    else if (name === 'browser_screenshot') {
      const image = await client.send('Page.captureScreenshot', { format: 'png' });
      return { content: [{ type: 'image', mimeType: 'image/png', data: image.data }] };
    } else if (name === 'browser_scroll') {
      await page.evaluate(y => scrollBy(0, y), Number(args.y) || 0); result = '已滚动';
    } else if (name === 'browser_press_key') {
      const key = args.key;
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...(key === 'Enter' ? { windowsVirtualKeyCode: 13, text: '\r' } : {}) });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key }); result = '已按键';
    }
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
  }

  close() { for (const detach of this.diagnosticTargets?.values() || []) detach(); this.diagnosticTargets?.clear(); for (const page of this.pages.values()) { page.detachDiagnostics?.(); page.client.close(); } this.closing = true; this.browserClient?.close(); }
}

module.exports = { NativeTools };
