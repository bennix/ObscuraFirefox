function oauthPopupHeaders(details) {
  const url = new URL(details.url);
  const loginHost = url.hostname === 'accounts.google.com' || ['appleid.apple.com', 'idmsa.apple.com'].includes(url.hostname);
  if (details.type !== 'main_frame' || url.protocol !== 'https:' || !loginHost) return {};
  // Google Identity Services returns its result to the window that opened it.
  // NW.js guests lose that relationship when this popup changes browsing groups.
  return { responseHeaders: (details.responseHeaders || []).filter(header => header.name.toLowerCase() !== 'cross-origin-opener-policy') };
}
function xLoginHeaders(details, enabled) {
  const url = new URL(details.url);
  if (enabled !== true || details.type !== 'main_frame' || url.protocol !== 'https:' || !/(^|\.)x\.com$/.test(url.hostname)) return {};
  return { responseHeaders: (details.responseHeaders || []).filter(header => header.name.toLowerCase() !== 'cross-origin-opener-policy') };
}
module.exports = { oauthPopupHeaders, xLoginHeaders };
