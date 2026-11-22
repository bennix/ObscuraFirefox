const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { oauthPopupHeaders, xLoginHeaders } = require('../oauth-popup.cjs');
const { chromeClientHints } = require('../chrome-client.cjs');

test('X opener compatibility requires opt-in and leaves other origins and headers intact', () => {
  const headers = [{ name: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' }, { name: 'Content-Security-Policy', value: "default-src 'self'" }, { name: 'Set-Cookie', value: 'fixture=true; Secure' }];
  const details = { url: 'https://x.com/', type: 'main_frame', responseHeaders: headers };
  assert.deepEqual(xLoginHeaders(details, true).responseHeaders, headers.slice(1));
  assert.deepEqual(xLoginHeaders({ ...details, url: 'https://jf.x.com/' }, true).responseHeaders, headers.slice(1));
  assert.deepEqual(xLoginHeaders(details, false), {});
  assert.deepEqual(xLoginHeaders({ ...details, type: 'sub_frame' }, true), {});
  for (const url of ['https://claude.ai/', 'https://accounts.google.com/', 'https://x.com.evil.test/', 'http://x.com/']) {
    assert.deepEqual(xLoginHeaders({ ...details, url }, true), {});
  }
});

test('Google OAuth popup preserves opener across response isolation headers', () => {
  const headers = [{ name: 'Cross-Origin-Opener-Policy', value: 'same-origin' }, { name: 'Set-Cookie', value: 'fixture=true; Secure' }, { name: 'Content-Security-Policy', value: "default-src 'self'" }];
  const result = oauthPopupHeaders({ url: 'https://accounts.google.com/gsi/transform', type: 'main_frame', responseHeaders: headers });
  assert.deepEqual(result.responseHeaders.map(header => header.name), ['Set-Cookie', 'Content-Security-Policy']);
  assert.equal(oauthPopupHeaders({ url: 'https://appleid.apple.com/auth/authorize', type: 'main_frame', responseHeaders: headers }).responseHeaders.some(header => header.name === 'Cross-Origin-Opener-Policy'), false);
  assert.deepEqual(oauthPopupHeaders({ url: 'https://example.com/', type: 'main_frame', responseHeaders: headers }), {});
  assert.deepEqual(oauthPopupHeaders({ url: 'https://accounts.google.com/gsi/iframe', type: 'sub_frame', responseHeaders: headers }), {});
});

test('YouTube ads run at 8x and content returns to its original rate with reused or replaced videos', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension/youtube-ads.js'), 'utf8');
  let ad = false;
  let video = { playbackRate: 1 };
  let mutation, interval;
  const events = {};
  const player = { classList: { contains: name => ad && name === 'ad-showing' }, querySelector: () => video };
  const preview = { playbackRate: 1 };
  const idlePlayer = { classList: { contains: () => false }, querySelector: () => preview };
  const document = { querySelectorAll: () => [idlePlayer, player], addEventListener: (name, handler) => { events[name] = handler; } };
  vm.runInNewContext(source, { location: { hostname: 'www.youtube.com' }, document, MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} }, setInterval: callback => { interval = callback; } });
  assert.equal(video.playbackRate, 1);
  video.playbackRate = 1.5;
  ad = true; mutation(); assert.equal(video.playbackRate, 8);
  assert.equal(preview.playbackRate, 1);
  video.playbackRate = 1; events.ratechange(); assert.equal(video.playbackRate, 8);
  ad = false; mutation(); assert.equal(video.playbackRate, 1.5);
  ad = true; mutation();
  const previous = video; video = { playbackRate: 1 }; interval();
  assert.equal(previous.playbackRate, 1.5); assert.equal(video.playbackRate, 8);
  ad = false; events['yt-navigate-finish'](); assert.equal(video.playbackRate, 1);
});

test('Chromium guests gain the Google Chrome brand without changing version or platform', () => {
  const override = chromeClientHints({ ua: 'Mozilla/5.0 Chrome/157.0.0.0 Safari/537.36', brands: [{ brand: 'Chromium', version: '157' }, { brand: 'Not-A.Brand', version: '99' }], fullVersion: '157.0.8103.39', platformName: 'macOS', platformVersion: '15.6.0', architecture: 'arm', bitness: '64', mobile: false });
  assert.equal(override.userAgent.includes('Chrome/157.0.0.0'), true);
  assert.deepEqual(override.userAgentMetadata.brands.map(item => item.brand), ['Chromium', 'Google Chrome', 'Not-A.Brand']);
  assert.equal(override.userAgentMetadata.fullVersionList[1].version, '157.0.8103.39');
  assert.equal(override.userAgentMetadata.platform, 'macOS');
  assert.equal(override.userAgentMetadata.architecture, 'arm');
  assert.equal(chromeClientHints({ ua: 'Mozilla/5.0 Chrome/157.0.0.0', brands: [{ brand: 'Google Chrome', version: '157' }] }), null);
  assert.equal(chromeClientHints({ ua: 'Mozilla/5.0 Safari/537.36', brands: [] }), null);
});

test('approved compatibility is limited to X and keeps native constructors there', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension/privacy.js'), 'utf8');
  function surface(host, enabled) {
    const context = vm.createContext({ location: { hostname: host }, __obscuraAuthCompatibility: enabled, DOMException,
      HTMLCanvasElement: class { toDataURL() { return 'native-canvas'; } }, RTCPeerConnection: function () {}, OfflineAudioContext: function () {} });
    vm.runInContext('globalThis.navigator = {};', context);
    vm.runInContext(source, context);
    vm.runInContext(source, context);
    return vm.runInContext('({rtc:typeof RTCPeerConnection,audio:typeof OfflineAudioContext,canvas:(()=>{try{return new HTMLCanvasElement().toDataURL()}catch(error){return error.name}})()})', context);
  }
  assert.equal(surface('x.com', true).canvas, 'native-canvas');
  assert.equal(surface('jf.x.com', true).audio, 'function');
  assert.equal(surface('x.com', true).rtc, 'function');
  assert.equal(surface('jf.x.com', false).rtc, 'undefined');
  assert.equal(surface('challenges.cloudflare.com', false).rtc, 'function');
  assert.equal(surface('challenges.cloudflare.com', false).canvas, 'native-canvas');
  for (const host of ['accounts.google.com', 'youtube.com', 'example.com', 'x.com.evil.test', 'claude.ai', 'www.claude.ai', 'auth.claude.ai']) {
    assert.equal(surface(host, true).canvas, 'NotAllowedError');
    assert.equal(surface(host, true).rtc, 'undefined');
    assert.equal(surface(host, true).audio, 'undefined');
  }
  assert.equal(surface('x.com', false).canvas, 'NotAllowedError');
});
