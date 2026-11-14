(() => {
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  if (globalThis.__obscuraYouTubeAds) return;
  globalThis.__obscuraYouTubeAds = true;
  const accelerated = new Set();
  function update() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    const advertisement = !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));
    const video = player?.querySelector('video');
    for (const previous of accelerated) {
      if (previous !== video || !advertisement) {
        previous.playbackRate = 1;
        accelerated.delete(previous);
      }
    }
    if (!video || !advertisement) return;
    accelerated.add(video);
    if (video.playbackRate !== 8) video.playbackRate = 8;
  }
  const observer = new MutationObserver(update);
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  for (const event of ['loadedmetadata', 'play', 'ratechange', 'yt-navigate-finish']) document.addEventListener(event, update, true);
  setInterval(update, 500);
  update();
})();
