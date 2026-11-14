(() => {
  if (!/(^|\.)(x\.com|twitter\.com|accounts\.google\.com|accounts\.youtube\.com)$/.test(location.hostname)) return;
  if (globalThis.__obscuraAuthTrace) return;
  globalThis.__obscuraAuthTrace = true;
  const known = new Set(['type', 'method', 'action', 'id', 'credential', 'token', 'response', 'error', 'code', 'state', 'nonce', 'g_csrf_token', 'client_id', 'select_by']);
  document.addEventListener('click', event => {
    const control = event.target?.closest?.('button,[role=button]');
    if (!control || !/Google/i.test(control.textContent || control.getAttribute('aria-label') || '')) return;
    globalThis.obscuraAuthEvent?.(JSON.stringify({ kind: 'interaction', control: 'google-sign-in', trusted: event.isTrusted, focused: document.hasFocus(), active: navigator.userActivation?.isActive, sticky: navigator.userActivation?.hasBeenActive }));
  }, true);
  addEventListener('message', event => {
    const data = event.data;
    const keys = data && typeof data === 'object' ? Object.keys(data) : [];
    globalThis.obscuraAuthEvent?.(JSON.stringify({
      origin: event.origin, sourceIsOpener: event.source === opener, sourceIsParent: event.source === parent,
      dataType: typeof data, stringLength: typeof data === 'string' ? data.length : undefined,
      knownKeys: keys.filter(key => known.has(key)), fieldCount: keys.length,
      credentialPresent: keys.some(key => ['credential', 'token', 'id_token', 'access_token'].includes(key))
    }));
  });
})();
