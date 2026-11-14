// Remember the media under the pointer, including players' overlay controls.
let obscuraContextMedia = null;
document.addEventListener('contextmenu', event => {
  obscuraContextMedia = null;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const host = location.hostname;
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const video = new URL(location.href).searchParams.get('v');
    const short = location.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/);
    const id = video || short?.[1];
    if (id) obscuraContextMedia = { url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, media: true };
    return;
  }
  if (!['x.com', 'twitter.com'].includes(host)) return;
  const image = target.closest('img');
  if (image && new URL(image.currentSrc || image.src).hostname === 'pbs.twimg.com') {
    const url = new URL(image.currentSrc || image.src);
    if (url.pathname.startsWith('/media/')) { url.searchParams.set('name', 'orig'); obscuraContextMedia = { url: url.href, media: false }; }
    return;
  }
  const player = target.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]');
  if (!player && !target.closest('video')) return;
  const article = target.closest('article');
  const permalink = article?.querySelector('a[href*="/status/"] time')?.closest('a') || article?.querySelector('a[href*="/status/"]');
  const url = permalink?.href || (/\/status\/\d+/.test(location.pathname) ? location.href : null);
  if (url) obscuraContextMedia = { url: url.replace(/\/(?:video|photo)\/\d+.*$/, ''), media: true };
}, true);
browser.runtime.onMessage.addListener(message => {
  if (message.type === 'media-context-target') return Promise.resolve(obscuraContextMedia);
});
