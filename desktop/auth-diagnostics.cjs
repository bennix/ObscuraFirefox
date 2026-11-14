const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

function relevant(value) {
  try { return /(^|\.)(x\.com|twitter\.com)$/.test(new URL(value).hostname) || ['accounts.google.com', 'accounts.youtube.com', 'appleid.apple.com', 'idmsa.apple.com'].includes(new URL(value).hostname); }
  catch { return false; }
}
function safeURL(value) {
  if (['null', '*', 'about:blank'].includes(value)) return value;
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'chrome-extension:'].includes(url.protocol)) return url.protocol;
    const pathname = url.pathname.replace(/[A-Za-z0-9_-]{32,}/g, '[opaque]').replace(/\b\d{7,}\b/g, '[id]');
    return url.origin + pathname;
  } catch { return ''; }
}
function scrub(value, key = '') {
  if (/^(authorization|proxy-authorization|cookie|set-cookie|password|key|api[-_]?key|token|access_token|id_token|refresh_token|credential|postData|body)$/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.slice(0, 30).map(item => scrub(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([name, item]) => [name, scrub(item, name)]));
  if (typeof value !== 'string') return value;
  if (key === 'reasons' && /^[A-Za-z]{1,100}$/.test(value)) return value;
  if (/^(?:https?|chrome-extension):\/\/\S+$/.test(value)) return safeURL(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[email]').slice(0, 800);
  return value.replace(/(?:https?|chrome-extension):\/\/[^\s'"<>]+/g, safeURL)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[email]')
    .replace(/Bearer\s+[^\s,;'"}]+/ig, 'Bearer [redacted]')
    .replace(/((?:password|api[-_]?key|token|credential|secret)\s*[:=]\s*)[^\s,;'"}]+/ig, '$1[redacted]')
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, '[opaque]').slice(0, 800);
}
function errorCategory(value) {
  const text = String(value || '');
  if (/Cannot read properties of null.*postMessage|opener.*null/i.test(text)) return 'popup-opener-missing';
  if (/An unexpected error occurred/i.test(text)) return 'unexpected-error';
  if (/Cross-Origin-Opener-Policy|cross-origin|CORS/i.test(text)) return 'cross-origin-policy';
  if (/NotAllowedError|Blocked by Obscura/i.test(text)) return 'privacy-or-permission';
  if (/captcha|challenge/i.test(text)) return 'security-challenge';
  if (/csrf/i.test(text)) return 'csrf';
  if (/expired/i.test(text)) return 'expired';
  if (/Failed to fetch|NetworkError|ERR_/i.test(text)) return 'network';
  if (/TypeError/i.test(text)) return 'type-error';
  if (/ReferenceError/i.test(text)) return 'reference-error';
  return 'unspecified-error';
}
function readableStrings(text) {
  const found = [];
  const pattern = /[\u0020-\u007e\u00a0-\u024f\u4e00-\u9fff]{4,120}/g;
  for (const match of String(text || '').matchAll(pattern)) {
    const value = scrub(match[0].replace(/\s+/g, ' ').trim());
    if (!value || found.includes(value)) continue;
    found.push(value);
    if (found.length >= 12) break;
  }
  return found;
}
function responseSummary(text) {
  const summary = { bytes: Buffer.byteLength(text), unexpectedError: /An unexpected error occurred\. Please try again\./i.test(text), strings: readableStrings(text) };
  try {
    const data = JSON.parse(text);
    const errors = data.errors || (data.error ? [data.error] : []);
    summary.errors = errors.slice(0, 5).map(error => ({ code: typeof error.code === 'number' || /^[A-Z_]{2,40}$/.test(error.code || '') ? error.code : undefined, category: errorCategory(error.message || (typeof error === 'string' ? error : '')) }));
  } catch {
    summary.format = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? 'binary-or-framed-text' : 'text';
    summary.errorLabels = [...new Set(text.match(/\b(?:sso|auth|login|invalid|expired|denied|captcha|challenge|csrf)[_-][a-z0-9_-]{1,40}\b/gi) || [])].slice(0, 10);
  }
  return summary;
}
function credentialSummary(text, audiences = new Set(), nonces = new Set()) {
  const match = String(text || '').match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!match) return { tokenFound: false };
  try {
    const [headerPart, payloadPart] = match[0].split('.');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    const audience = typeof payload.aud === 'string' ? createHash('sha256').update(payload.aud).digest('hex').slice(0, 12) : undefined;
    return { tokenFound: true, parsed: true, algorithm: ['RS256', 'ES256'].includes(header.alg) ? header.alg : 'other', issuerIsGoogle: ['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss), audience, audienceObserved: audiences.size ? audiences.has(audience) : undefined, noncePresent: typeof payload.nonce === 'string', nonceObserved: nonces.size && typeof payload.nonce === 'string' ? nonces.has(payload.nonce) : undefined, expired: typeof payload.exp === 'number' ? payload.exp <= Date.now() / 1000 : undefined, emailVerified: payload.email_verified === true, subjectPresent: typeof payload.sub === 'string', signature: 'not-verified' };
  } catch { return { tokenFound: true, parsed: false }; }
}
class AuthDiagnostics {
  constructor(directory, maxBytes = 5 * 1024 * 1024) {
    this.directory = path.join(directory, 'logs'); this.file = path.join(this.directory, 'x-login.jsonl');
    this.connections = new Map(); this.maxBytes = maxBytes; this.session = randomBytes(6).toString('hex'); this.size = 0; this.writeError = ''; this.audiences = new Set(); this.nonces = new Set();
    this.pending = fs.mkdir(this.directory, { recursive: true, mode: 0o700 }).then(async () => {
      await fs.chmod(this.directory, 0o700);
      try { this.size = (await fs.stat(this.file)).size; await fs.chmod(this.file, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }).catch(error => { this.writeError = error.message; });
    this.record('capture.start', { session: this.session });
  }
  id(value) { return value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 12) : undefined; }
  record(event, data = {}) {
    const line = JSON.stringify({ time: new Date().toISOString(), session: this.session, event, ...scrub(data) }) + '\n';
    this.pending = this.pending.then(async () => {
      if (this.size + Buffer.byteLength(line) > this.maxBytes) {
        await fs.rm(this.file + '.2', { force: true });
        await fs.rename(this.file + '.1', this.file + '.2').catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fs.rename(this.file, this.file + '.1').catch(error => { if (error.code !== 'ENOENT') throw error; });
        this.size = 0;
      }
      await fs.appendFile(this.file, line, { mode: 0o600 }); this.size += Buffer.byteLength(line);
    }).catch(error => { this.writeError = error.message; });
  }
  async flush() { await this.pending; return { file: this.file, writeError: this.writeError, session: this.session }; }
  attach(client, target, sessionId) {
    const connectionId = target.targetId || target.id;
    this.connections.get(connectionId)?.();
    let active = true;
    const context = { url: target.url }; const requests = new Map(); const removers = [];
    const targetId = this.id(target.targetId || target.id);
    const write = (event, data) => this.record(event, { target: targetId, ...data });
    const on = (name, listener) => removers.push(client.on(name, (event, incomingSession) => { if (incomingSession === sessionId) listener(event); }));
    const send = (method, params = {}) => client.send(method, params, sessionId);
    const snapshot = async reason => {
      if (!relevant(context.url)) return;
      try {
        const result = await send('Runtime.evaluate', { expression: `(()=>{let canvasAllowed;try{document.createElement('canvas').toDataURL();canvasAllowed=true}catch{canvasAllowed=false}const ua=navigator.userAgent||'';return {origin:location.origin,ready:document.readyState,opener:!!opener,openerClosed:opener?opener.closed:null,isTop:top===self,node:typeof require,rtc:typeof RTCPeerConnection,audio:typeof OfflineAudioContext,canvasAllowed,cookiesEnabled:navigator.cookieEnabled,isolated:crossOriginIsolated,userGesture:navigator.userActivation?.isActive,stickyActivation:navigator.userActivation?.hasBeenActive,focused:document.hasFocus(),visibleError:!!document.body?.innerText.includes('An unexpected error occurred. Please try again.'),uaApp:/nwjs|Electron/i.test(ua),webdriver:navigator.webdriver===true,language:navigator.language,languages:(navigator.languages||[]).slice(0,4),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,platform:navigator.platform,cores:navigator.hardwareConcurrency,memory:navigator.deviceMemory,brands:(navigator.userAgentData?.brands||[]).map(item=>item.brand).slice(0,6),chromeMajor:(ua.match(/Chrome\\/(\\d+)/)||[])[1]||''}})()`, returnByValue: true, userGesture: false });
        if (result.result?.value) write('page.state', { reason, ...result.result.value });
      } catch (error) { write('page.state.error', { message: error.message }); }
    };
    on('Page.frameNavigated', event => {
      if (!event.frame.parentId) context.url = event.frame.url;
      if (relevant(event.frame.url)) write('navigation', { url: safeURL(event.frame.url), childFrame: !!event.frame.parentId });
    });
    on('Page.loadEventFired', () => { snapshot('load').catch(() => {}); });
    on('Network.requestWillBeSent', event => {
      if (!relevant(event.request.url) && !relevant(event.documentURL) && !relevant(context.url)) return;
      const headers = Object.fromEntries(Object.entries(event.request.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
      const info = { url: safeURL(event.request.url), method: event.request.method, type: event.type, authPath: /login|signin|oauth|gsi|onboarding|authenticate|authorize|guest\/activate/i.test(event.request.url) };
      const url = new URL(event.request.url);
      if (url.hostname === 'accounts.google.com') {
        const clientId = url.searchParams.get('client_id');
        const nonce = url.searchParams.get('nonce');
        if (clientId) {
          const audience = this.id(clientId); this.audiences.add(audience);
          if (this.audiences.size > 32) this.audiences.delete(this.audiences.values().next().value);
          write('google.client', { request: this.id(event.requestId), audience, noncePresent: !!nonce });
        }
        if (nonce) { this.nonces.add(nonce); if (this.nonces.size > 32) this.nonces.delete(this.nonces.values().next().value); }
      }
      if (info.authPath && /(^|\.)x\.com$/.test(url.hostname) && event.request.postData) write('credential.state', { request: this.id(event.requestId), ...credentialSummary(event.request.postData, this.audiences, this.nonces) });
      requests.set(event.requestId, info);
      if (requests.size > 1000) requests.delete(requests.keys().next().value);
      if (info.authPath || event.type === 'Document') write('request', { request: this.id(event.requestId), ...info, document: safeURL(event.documentURL), origin: safeURL(headers.origin), referer: safeURL(headers.referer), fetchSite: headers['sec-fetch-site'], authorizationPresent: !!headers.authorization, csrfPresent: !!headers['x-csrf-token'], cookieHeaderPresent: !!headers.cookie, hasPostData: event.request.hasPostData === true, payloadBytes: typeof event.request.postData === 'string' ? Buffer.byteLength(event.request.postData) : undefined, redirectStatus: event.redirectResponse?.status, userAgent: scrub(headers['user-agent'] || '').slice(0, 180), secChUa: scrub(headers['sec-ch-ua'] || '').slice(0, 180), acceptLanguage: String(headers['accept-language'] || '').slice(0, 80) });
    });
    on('Network.requestWillBeSentExtraInfo', event => {
      const info = requests.get(event.requestId);
      if (!info && !relevant(context.url)) return;
      const blocked = (event.associatedCookies || []).filter(item => item.blockedReasons?.some(reason => !['DomainMismatch', 'NotOnPath'].includes(reason)));
      for (const item of blocked) write('cookie.request.blocked', { request: this.id(event.requestId), url: info?.url, name: /^[\w.$-]{1,80}$/.test(item.cookie?.name || '') ? item.cookie.name : '[name]', reasons: item.blockedReasons });
      const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
      if (info?.authPath) write('request.headers', { request: this.id(event.requestId), origin: safeURL(headers.origin), referer: safeURL(headers.referer), csrfPresent: !!headers['x-csrf-token'], authorizationPresent: !!headers.authorization, cookieHeaderPresent: !!headers.cookie, fetchSite: headers['sec-fetch-site'] });
    });
    on('Network.responseReceived', event => {
      const info = requests.get(event.requestId);
      if (!info) return;
      info.status = event.response.status; info.mime = event.response.mimeType;
      if (info.authPath || info.status >= 400) {
        const headers = Object.fromEntries(Object.entries(event.response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
        write('response', { request: this.id(event.requestId), url: info.url, status: info.status, mime: info.mime, protocol: event.response.protocol, fromServiceWorker: event.response.fromServiceWorker, coop: headers['cross-origin-opener-policy'], allowOrigin: safeURL(headers['access-control-allow-origin']) });
      }
    });
    on('Network.responseReceivedExtraInfo', event => {
      const info = requests.get(event.requestId);
      if (!info && !relevant(context.url)) return;
      for (const item of event.blockedCookies || []) write('cookie.response.blocked', { request: this.id(event.requestId), url: info?.url, reasons: item.blockedReasons });
    });
    on('Network.loadingFinished', async event => {
      const info = requests.get(event.requestId); requests.delete(event.requestId);
      if (!info?.authPath || !/(^|\.)x\.com$/.test(new URL(info.url).hostname) || event.encodedDataLength > 256000) return;
      try {
        const result = await send('Network.getResponseBody', { requestId: event.requestId });
        const text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body;
        write('response.summary', { request: this.id(event.requestId), url: info.url, status: info.status, ...responseSummary(text) });
      } catch (error) { write('response.summary.error', { url: info.url, message: error.message }); }
    });
    on('Network.loadingFailed', event => {
      const info = requests.get(event.requestId); requests.delete(event.requestId);
      if (info) write('request.failed', { request: this.id(event.requestId), url: info.url, error: event.errorText, blockedReason: event.blockedReason, cors: event.corsErrorStatus, canceled: event.canceled });
    });
    on('Runtime.exceptionThrown', event => {
      const details = event.exceptionDetails;
      if (!relevant(context.url) && !relevant(details.url)) return;
      write('script.exception', { category: errorCategory(details.exception?.description || details.text), className: details.exception?.className, url: safeURL(details.url), frames: details.stackTrace?.callFrames.slice(0, 5).map(frame => ({ function: frame.functionName, url: safeURL(frame.url), line: frame.lineNumber })) });
    });
    on('Runtime.consoleAPICalled', event => {
      if (!relevant(context.url) || !['error', 'warning'].includes(event.type)) return;
      const text = event.args.map(item => typeof item.value === 'string' ? item.value : item.description || '').join(' ').slice(0, 500);
      write('script.console', { level: event.type, categories: [...new Set(event.args.filter(item => typeof item.value === 'string').map(item => errorCategory(item.value)))], text: scrub(text) });
    });
    on('Runtime.bindingCalled', event => {
      if (event.name !== 'obscuraAuthEvent' || event.payload.length > 4000) return;
      try {
        const data = JSON.parse(event.payload);
        if (data.kind === 'interaction' && relevant(context.url)) {
          write('interaction', { control: 'google-sign-in', trusted: data.trusted === true, focused: data.focused === true, active: data.active === true, sticky: data.sticky === true });
          return;
        }
        if (!relevant(context.url) && !relevant(data.origin)) return;
        write('message', { origin: safeURL(data.origin), sourceIsOpener: data.sourceIsOpener === true, sourceIsParent: data.sourceIsParent === true, dataType: data.dataType, stringLength: data.stringLength, knownKeys: Array.isArray(data.knownKeys) ? data.knownKeys.filter(key => ['type', 'method', 'action', 'id', 'credential', 'token', 'response', 'error', 'code', 'state', 'nonce', 'g_csrf_token', 'client_id', 'select_by'].includes(key)) : [], fieldCount: data.fieldCount, credentialPresent: data.credentialPresent === true });
        if (data.credentialPresent) snapshot('credential-message').catch(() => {});
      } catch {}
    });
    if (relevant(target.url)) write('target.attached', { url: safeURL(target.url), type: target.type, opener: this.id(target.openerId), waiting: target.waitingForDebugger });
    const detach = () => {
      if (!active) return;
      active = false;
      for (const remove of removers) remove();
      if (this.connections.get(connectionId) === detach) this.connections.delete(connectionId);
      if (relevant(context.url)) write('target.detached', { url: safeURL(context.url) });
    };
    this.connections.set(connectionId, detach);
    if (!target.waitingForDebugger) snapshot('attached').catch(() => {});
    return detach;
  }
}
module.exports = { AuthDiagnostics, scrub, safeURL, responseSummary, credentialSummary, relevant };
