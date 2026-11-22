(() => {
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  if (globalThis.__obscuraYouTubeAds) return;
  globalThis.__obscuraYouTubeAds = true;
  const accelerated = new Map();
  function update() {
    const adVideos = new Set();
    for (const player of document.querySelectorAll('.html5-video-player, #movie_player')) {
      if (!player.classList.contains('ad-showing') && !player.classList.contains('ad-interrupting')) continue;
      const video = player.querySelector('video.html5-main-video') || player.querySelector('video');
      if (video) adVideos.add(video);
    }
    for (const [video, originalRate] of accelerated) {
      if (adVideos.has(video)) continue;
      if (video.playbackRate === 8) video.playbackRate = originalRate;
      accelerated.delete(video);
    }
    for (const video of adVideos) {
      if (!accelerated.has(video)) accelerated.set(video, video.playbackRate);
      if (video.playbackRate !== 8) video.playbackRate = 8;
    }
  }
  const observer = new MutationObserver(update);
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  for (const event of ['loadedmetadata', 'play', 'ratechange', 'yt-navigate-finish']) document.addEventListener(event, update, true);
  setInterval(update, 500);
  update();
})();
