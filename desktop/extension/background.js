importScripts('bridge-config.js', 'media-sniffer.js');
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
async function bridge(path) {
  const response = await fetch(BRIDGE.origin + path, { headers: { 'X-Obscura-Token': BRIDGE.token } });
  if (!response.ok) throw new Error('无法读取本地代理配置');
  return response.json();
}
let appliedProxy = '';
async function applyProxy() {
  const config = await bridge('/proxy-config');
  const serialized = JSON.stringify(config);
  if (serialized === appliedProxy) return;
  await chrome.proxy.settings.set({ value: config, scope: 'regular' });
  appliedProxy = serialized;
}
applyProxy().catch(console.error);
setInterval(() => applyProxy().catch(console.error), 3000);
chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  if (!details.isProxy) { callback({}); return; }
  bridge('/proxy-auth').then(auth => {
    if (auth.username && auth.host === details.challenger.host && auth.port === details.challenger.port) {
      callback({ authCredentials: { username: auth.username, password: auth.password } });
    } else callback({});
  }).catch(() => callback({}));
}, { urls: ['<all_urls>'] }, ['asyncBlocking']);
async function clearStaleChallenges() {
  const names = ['cf_clearance', '__cf_bm', 'cf_chl_rc_ni'];
  const found = await chrome.cookies.getAll({});
  await Promise.all(found.filter(cookie => names.includes(cookie.name)).map(cookie => chrome.cookies.remove({
    url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
    name: cookie.name
  })));
}
async function privacy() {
  await clearStaleChallenges();
  if (chrome.privacy.websites.thirdPartyCookiesAllowed) await chrome.privacy.websites.thirdPartyCookiesAllowed.set({ value: true });
  await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
  await chrome.privacy.websites.hyperlinkAuditingEnabled.set({ value: false });
  await chrome.privacy.websites.topicsEnabled?.set({ value: false });
  await chrome.privacy.websites.adMeasurementEnabled?.set({ value: false });
  await chrome.privacy.websites.fledgeEnabled?.set({ value: false });
}
privacy().catch(console.error);
async function remember(tab) {
  if (tab?.url?.match(/^https?:/)) await chrome.storage.session.set({ lastTab: { id: tab.id, url: tab.url, title: tab.title || tab.url } });
}
chrome.tabs.onActivated.addListener(async ({ tabId }) => { try { await remember(await chrome.tabs.get(tabId)); } catch {} });
chrome.tabs.onUpdated.addListener((_, info, tab) => { if (tab.active && (info.status === 'complete' || info.url)) remember(tab); });
chrome.runtime.onMessage.addListener((message, _, respond) => {
  if (message.type === 'apply-proxy') { applyProxy().then(() => respond({ ok: true }), error => respond({ error: error.message })); return true; }
  if (message.type === 'active-tab') {
    (async () => {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.url?.match(/^https?:/)) { await remember(active); return { id: active.id, url: active.url, title: active.title }; }
      const { lastTab } = await chrome.storage.session.get('lastTab');
      return lastTab || {};
    })().then(respond); return true;
  }
});
