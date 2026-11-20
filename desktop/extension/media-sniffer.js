const mediaByTab = new Map();
const clearedMediaTabs = new Set();
const mediaRevisions = new Map();
function youtubePage(value) {
  try {
    const url = new URL(value);
    if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? 'https://www.youtube.com/watch?v=' + id : null;
  } catch { return null; }
}
async function listDetectedMedia(tabId) {
  if (clearedMediaTabs.has(tabId)) return [];
  const tab = await chrome.tabs.get(tabId);
  if (typeof browser !== 'undefined' && /^https?:\/\/(?:x\.com|twitter\.com)\//i.test(tab.url || '')) {
    // Query the live viewport each time. Network requests include preloaded and off-screen posts.
    const visible = await chrome.tabs.sendMessage(tabId, { type: 'media-visible-x' }, { frameId: 0 }).catch(() => null);
    if (!visible || visible.url !== tab.url || !Array.isArray(visible.media)) return [];
    return visible.media.filter(item => /^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(item.url)).map(item => ({
      key: item.url, url: item.url, downloadUrl: item.url, title: item.title || 'X', host: 'x.com', kind: 'X',
      size: null, source: tab.url, detection: 'viewport', detectedAt: Date.now()
    }));
  }
  const page = youtubePage(tab.url);
  const media = mediaByTab.get(tabId) || [];
  if (!page) return media;
  return [{ key: page, url: page, downloadUrl: page, title: tab.title || 'YouTube', host: 'youtube.com', kind: 'YouTube', size: null, source: tab.url, detection: 'page', detectedAt: Date.now() }, ...media.filter(item => item.downloadUrl !== page)];
}

async function recordMedia(details) {
  const revision = mediaRevisions.get(details.tabId);
  if (details.tabId < 0 || details.statusCode >= 400) return;
  const url = details.url;
  if (!/^https?:/i.test(url) || /\.(ts|m4s)(?:$|\?)/i.test(url)) return;
  const headers = details.responseHeaders || [];
  const parsed = new URL(url);
  const mime = headers.find(header => header.name.toLowerCase() === 'content-type')?.value || parsed.searchParams.get('mime') || '';
  const mediaMime = /^(video|audio)\//i.test(mime) ? mime : parsed.searchParams.get('mime') || mime;
  let kind;
  if (/\.m3u8(?:$|\?)/i.test(url) || /mpegurl/i.test(mime)) kind = 'HLS';
  else if (/\.mpd(?:$|\?)/i.test(url) || /dash\+xml/i.test(mime)) kind = 'DASH';
  else if (/mp2t/i.test(mime)) return;
  else if (/^(video|audio)\//i.test(mediaMime) || /\.(mp4|webm|mkv|mp3|m4a|aac|ogg|wav)(?:$|\?)/i.test(url)) kind = /^audio\//.test(mediaMime) ? '音频' : '视频';
  if (!kind) return;
  const list = mediaByTab.get(details.tabId) || [];
  const tab = await chrome.tabs.get(details.tabId).catch(() => ({}));
  if (revision !== mediaRevisions.get(details.tabId)) return;
  if (typeof browser !== 'undefined' && /^https?:\/\/(?:x\.com|twitter\.com)\//i.test(tab.url || '')) return;
  const youtube = /(^|\.)googlevideo\.com$/.test(parsed.hostname) && /(^|\.)youtube\.com$/.test(new URL(tab.url || url).hostname);
  const track = youtube ? parsed.searchParams.get('itag') : null;
  const key = track ? `${youtubePage(tab.url) || tab.url}#${track}` : url;
  const range = headers.find(header => header.name.toLowerCase() === 'content-range')?.value?.match(/\/(\d+)$/)?.[1];
  const size = ['HLS', 'DASH'].includes(kind) ? null : Number(parsed.searchParams.get('clen') || range || headers.find(header => header.name.toLowerCase() === 'content-length')?.value) || null;
  const existing = list.find(item => item.key === key);
  if (existing) { existing.size ||= size; return; }
  const format = track ? kind === '音频' ? track : `${track}+bestaudio/${track}` : undefined;
  list.unshift({ key, url, downloadUrl: youtube ? youtubePage(tab.url) || tab.url : url, format, kind, mime, size, source: tab.url,
    title: tab.title || parsed.pathname.split('/').pop() || parsed.hostname, host: parsed.hostname, detectedAt: Date.now() });
  mediaByTab.set(details.tabId, list.slice(0, 100));
}

chrome.webRequest.onHeadersReceived.addListener(details => { recordMedia(details).catch(() => {}); }, { urls: ['<all_urls>'] }, ['responseHeaders']);
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.url) { clearedMediaTabs.delete(tabId); const page = youtubePage(change.url); const prior = mediaByTab.get(tabId); if (!page || prior?.some(item => youtubePage(item.source) !== page)) mediaByTab.delete(tabId); } });
chrome.tabs.onRemoved.addListener(tabId => { mediaByTab.delete(tabId); clearedMediaTabs.delete(tabId); mediaRevisions.delete(tabId); });
chrome.runtime.onMessage.addListener((message, _, respond) => {
  if (message.type === 'media-list') { listDetectedMedia(message.tabId).then(media => respond({ media, cleared: clearedMediaTabs.has(message.tabId) }), () => respond({ media: [] })); return true; }
  if (message.type === 'media-clear') {
    mediaByTab.delete(message.tabId);
    mediaRevisions.set(message.tabId, (mediaRevisions.get(message.tabId) || 0) + 1);
    clearedMediaTabs.add(message.tabId);
    respond({ ok: true });
  }
  if (message.type === 'media-rescan') { clearedMediaTabs.delete(message.tabId); respond({ ok: true }); }
});
