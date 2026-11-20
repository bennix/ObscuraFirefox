const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../firefox/media-context.js'), 'utf8');
function fixture(url) {
  let contextMenu, message;
  class Element { closest() { return null; } }
  vm.runInNewContext(source, { URL, Element, location: new URL(url), window: { addEventListener: (type, callback) => { if (type === 'contextmenu') contextMenu = callback; } }, browser: { runtime: { onMessage: { addListener: callback => { message = callback; } } } } });
  return { Element, click: async target => { contextMenu({ target, stopImmediatePropagation() {} }); return message({ type: 'media-context-target' }); } };
}
test('YouTube watch and Shorts context resolve canonical video rather than blob', async () => {
  for (const url of ['https://www.youtube.com/watch?v=abc123&t=20', 'https://www.youtube.com/shorts/abc123']) {
    const f = fixture(url);
    const result = await f.click(new f.Element());
    assert.equal(result.url, 'https://www.youtube.com/watch?v=abc123');
    assert.equal(result.media, true);
  }
  const f = fixture('https://www.youtube.com/');
  assert.equal(await f.click(new f.Element()), null);
});
test('X uses original image and the clicked player article, never another feed item', async () => {
  const f = fixture('https://x.com/home');
  const image = new f.Element(); image.src = 'https://pbs.twimg.com/media/abc?format=jpg&name=small';
  image.closest = selector => selector === 'img' ? image : null;
  const photo = await f.click(image);
  assert.equal(new URL(photo.url).searchParams.get('name'), 'orig');
  assert.equal(photo.media, false);
  const video = new f.Element();
  video.closest = selector => selector.includes('videoPlayer') ? video : selector === 'article' ? { querySelector: selector => selector.endsWith('time') ? null : { href: 'https://x.com/example/status/123' } } : null;
  assert.equal((await f.click(video)).url, 'https://x.com/example/status/123');
  assert.equal(await f.click(new f.Element()), null);
});
test('YouTube thumbnail chooses the clicked video instead of the watch page', async () => {
  const f = fixture('https://www.youtube.com/watch?v=current');
  const thumbnail = new f.Element();
  thumbnail.closest = selector => selector === 'a[href]' ? { href: 'https://www.youtube.com/watch?v=clicked' } : null;
  assert.equal((await f.click(thumbnail)).url, 'https://www.youtube.com/watch?v=clicked');
});
test('generic streamed players use the page URL for blob playback', async () => {
  const f = fixture('https://example.com/stream/1');
  const video = new f.Element(); video.currentSrc = 'blob:https://example.com/123';
  video.closest = selector => selector === 'video, audio' ? video : null;
  assert.equal((await f.click(video)).url, 'https://example.com/stream/1');
  video.currentSrc = 'https://cdn.example.com/master.m3u8';
  assert.equal((await f.click(video)).url, video.currentSrc);
});
