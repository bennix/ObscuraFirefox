(() => {
  if (globalThis.__obscuraFullscreenInstalled) return;
  const challenge = () => /(^|\.)cloudflare\.com$/i.test(location.hostname) || /\/cdn-cgi\/challenge-platform\//.test(location.pathname || '') || /Just a moment|Verifying you are human|正在进行安全验证/i.test(`${document.title || ''} ${(document.body?.innerText || '').slice(0, 300)}`) || [...document.scripts].some(script => /challenge-platform|turnstile/i.test(script.src || ''));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (!challenge()) install(); }, { once: true });
    return;
  }
  if (challenge()) return;
  install();
  function install() {
  if (globalThis.__obscuraFullscreenInstalled || challenge()) return;
  globalThis.__obscuraFullscreenInstalled = true;
  let current = null;
  const changes = [];
  function style(element, properties) {
    const saved = Object.entries(properties).map(([name, value]) => {
      const previous = [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)];
      element.style.setProperty(name, value, 'important');
      return previous;
    });
    changes.push({ element, saved });
  }
  function notify(element) {
    const target = element?.isConnected ? element : document;
    target.dispatchEvent(new Event('fullscreenchange', { bubbles: true }));
    target.dispatchEvent(new Event('webkitfullscreenchange', { bubbles: true }));
  }
  async function exit() {
    if (!current) return;
    const previous = current; current = null;
    for (const { element, saved } of changes.reverse()) for (const [name, value, priority] of saved) {
      if (value) element.style.setProperty(name, value, priority); else element.style.removeProperty(name);
    }
    changes.length = 0;
    globalThis.obscuraFullscreen?.(JSON.stringify({ enabled: false }));
    notify(previous);
  }
  async function enter() {
    if (!navigator.userActivation.isActive) throw new DOMException('Fullscreen requires a user gesture', 'NotAllowedError');
    if (!this.isConnected) throw new DOMException('Element is detached', 'InvalidStateError');
    if (typeof globalThis.obscuraFullscreen !== 'function') throw new DOMException('Fullscreen host is unavailable', 'NotSupportedError');
    if (current === this) return;
    await exit();
    current = this;
    for (let ancestor = this.parentElement; ancestor; ancestor = ancestor.parentElement) {
      style(ancestor, { transform: 'none', perspective: 'none', filter: 'none', contain: 'none', overflow: 'visible', 'clip-path': 'none', 'z-index': 'auto' });
    }
    style(this, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', 'max-width': 'none', 'max-height': 'none', margin: '0', 'z-index': '2147483647', background: '#000' });
    for (const video of this.tagName === 'VIDEO' ? [this] : this.querySelectorAll('video')) style(video, { width: '100%', height: '100%', 'object-fit': 'contain' });
    globalThis.obscuraFullscreen(JSON.stringify({ enabled: true }));
    notify(this);
  }
  for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) Object.defineProperty(Element.prototype, name, { value: enter, configurable: true, writable: true });
  for (const name of ['fullscreenElement', 'webkitFullscreenElement']) Object.defineProperty(document, name, { get: () => current, configurable: true });
  for (const name of ['fullscreenEnabled', 'webkitFullscreenEnabled']) Object.defineProperty(document, name, { get: () => true, configurable: true });
  Object.defineProperty(document, 'webkitIsFullScreen', { get: () => !!current, configurable: true });
  for (const name of ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen']) Object.defineProperty(document, name, { value: exit, configurable: true });
  Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', { value: enter, configurable: true });
  Object.defineProperty(HTMLVideoElement.prototype, 'webkitExitFullscreen', { value: exit, configurable: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && current) { event.preventDefault(); event.stopImmediatePropagation(); exit(); } }, true);
  new MutationObserver(() => { if (current && !current.isConnected) exit(); }).observe(document, { childList: true, subtree: true });
  addEventListener('pagehide', () => { if (current) globalThis.obscuraFullscreen?.(JSON.stringify({ enabled: false })); });
  }
})();
