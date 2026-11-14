(() => {
  const privacyKey = Symbol.for('obscura.privacy.initialized');
  if (globalThis[privacyKey]) return;
  Object.defineProperty(globalThis, privacyKey, { value: true });
  const host = location.hostname;
  const googleLoginHost = host === 'accounts.google.com';
  const compatibleHost = /(^|\.)x\.com$/.test(host);
  const appleLoginHost = location.protocol === 'https:' && ['appleid.apple.com', 'idmsa.apple.com'].includes(host) && /^\/(?:auth\/(?:authorize|signin)|appleauth\/auth)(?:\/|$)/.test(location.pathname || '');
  if (globalThis.__obscuraAuthCompatibility === true && compatibleHost) return;
  if (globalThis.__obscuraGoogleLoginCompatibility === true && (googleLoginHost || appleLoginHost)) return;

  function challengeDocument() {
    if (/(^|\.)cloudflare\.com$/i.test(location.hostname)) return true;
    if (/\/cdn-cgi\/challenge-platform\//.test(location.pathname || '')) return true;
    const nodes = typeof document === 'undefined' || !document.scripts ? [] : [...document.scripts];
    if (nodes.some(script => /challenge-platform|challenges\.cloudflare\.com\/turnstile/i.test(script.src || ''))) return true;
    const label = typeof document === 'undefined' ? '' : `${document.title || ''} ${(document.body?.innerText || '').slice(0, 400)}`;
    return /Just a moment|Verifying you are human|cf-browser-verification|正在进行安全验证/i.test(label);
  }

  function protect() {
    if (challengeDocument()) return;
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceGatherer']) {
      Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
    }
    const blocked = () => { throw new DOMException('Blocked by Obscura privacy protection', 'NotAllowedError'); };
    for (const name of ['OfflineAudioContext', 'webkitOfflineAudioContext']) {
      Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
    }
    for (const [prototype, methods] of [
      [globalThis.HTMLCanvasElement?.prototype, ['toDataURL', 'toBlob']],
      [globalThis.CanvasRenderingContext2D?.prototype, ['getImageData']],
      [globalThis.OffscreenCanvas?.prototype, ['convertToBlob']],
      [globalThis.OffscreenCanvasRenderingContext2D?.prototype, ['getImageData']]
    ]) {
      if (prototype) for (const method of methods) Object.defineProperty(prototype, method, { value: blocked, writable: false, configurable: false });
    }
    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const prototype = globalThis[name]?.prototype;
      if (!prototype) continue;
      const original = prototype.getExtension;
      Object.defineProperty(prototype, 'getExtension', { configurable: false, writable: false, value: function (extension) {
        if (String(extension).toLowerCase() === 'webgl_debug_renderer_info') return null;
        return original.call(this, extension);
      } });
      Object.defineProperty(prototype, 'readPixels', { value: blocked, writable: false, configurable: false });
    }
  }

  if (typeof document === 'undefined' || document.readyState !== 'loading') protect();
  else document.addEventListener('DOMContentLoaded', protect, { once: true });
})();
