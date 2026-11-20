// Resolve page URLs for streamed players instead of downloading blob URLs or fragments.
let obscuraContextMedia = null;
function obscuraYoutubeURL(value) {
  if (!value) return null;
  try {
    const url = new URL(value, location.href);
    if (!/(^|\.)youtube\.com$/.test(url.hostname) && url.hostname !== 'youtu.be') return null;
    const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1];
    return id && /^[\w-]+$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch { return null; }
}
function obscuraXPlayerURL(player) {
  const article = player.closest('article');
  const permalink = article?.querySelector('a[href*="/status/"] time')?.closest('a') || article?.querySelector('a[href*="/status/"]');
  try {
    const url = new URL(permalink?.href || location.href);
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    return ['x.com', 'twitter.com'].includes(url.hostname) && match ? `https://x.com/${match[1]}/status/${match[2]}` : null;
  } catch { return null; }
}
function obscuraVisibleXMedia() {
  if (!['x.com', 'twitter.com'].includes(location.hostname)) return [];
  const media = new Map();
  for (const player of document.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"], video')) {
    const rect = player.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    const style = getComputedStyle(player);
    if (right <= left || bottom <= top || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
    // Hit testing excludes feed players behind a modal or another overlay.
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    const owner = player.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]') || player.parentElement || player;
    if (!hit || !owner.contains(hit)) continue;
    const url = obscuraXPlayerURL(player);
    if (!url || media.has(url)) continue;
    const article = player.closest('article');
    media.set(url, { url, title: article?.querySelector('[data-testid="tweetText"]')?.textContent?.trim().slice(0, 180) || 'X 视频' });
  }
  return [...media.values()];
}
window.addEventListener('contextmenu', event => {
  obscuraContextMedia = null;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const host = location.hostname;
  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be') {
    const link = target.closest('a[href]');
    const card = target.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model');
    const url = obscuraYoutubeURL(link?.href) || obscuraYoutubeURL(card?.querySelector('a[href*="/watch?"], a[href*="/shorts/"]')?.href) || obscuraYoutubeURL(location.href);
    if (url) obscuraContextMedia = { url, media: true };
  } else if (['x.com', 'twitter.com'].includes(host)) {
    const player = target.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"], video');
    if (player) {
      const url = obscuraXPlayerURL(player);
      if (url) obscuraContextMedia = { url, media: true };
    } else {
      const image = target.closest('img');
      if (image) {
        try {
          const url = new URL(image.currentSrc || image.src);
          if (url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) {
            url.searchParams.set('name', 'orig');
            obscuraContextMedia = { url: url.href, media: false };
          }
        } catch {}
      }
    }
  } else {
    const media = target.closest('video, audio') || target.closest('[class*="player"], [class*="video"]')?.querySelector('video, audio');
    if (media) {
      const url = media.currentSrc || media.src || media.querySelector('source[src]')?.src;
      obscuraContextMedia = { url: /^https?:\/\//.test(url || '') ? url : location.href, media: true };
    }
  }
  if (!obscuraContextMedia && ['x.com', 'twitter.com'].includes(host) && /\/status\/\d+/.test(location.pathname)) {
    const url = obscuraXPlayerURL(target);
    if (url) obscuraContextMedia = { url, media: true };
  }
  if (obscuraContextMedia) event.stopImmediatePropagation();
}, true);
// Some X players open their own menu on the secondary pointer press.
for (const type of ['pointerdown', 'mousedown', 'mouseup']) {
  window.addEventListener(type, event => {
    if (event.button !== 2 || !['x.com', 'twitter.com'].includes(location.hostname)) return;
    event.stopImmediatePropagation();
  }, true);
}
browser.runtime.onMessage.addListener(message => {
  if (message.type === 'media-context-target') return Promise.resolve(obscuraContextMedia);
  if (message.type === 'media-visible-x') return Promise.resolve({ url: location.href, media: obscuraVisibleXMedia() });
});
