const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {mediaFormats}=require('../downloads.cjs');
test('YouTube page remains selectable without intercepted requests, including SPA and Shorts',async()=>{
 let url='https://www.youtube.com/watch?v=abcdefghijk&t=3';let changed;
 const api={tabs:{get:async()=>({url,title:'Fixture'}),onUpdated:{addListener:f=>changed=f},onRemoved:{addListener(){}}},webRequest:{onHeadersReceived:{addListener(){}}},runtime:{onMessage:{addListener(){}}}};
 const ctx={URL,chrome:api};vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../extension/media-sniffer.js'),'utf8'),ctx);
 assert.equal((await ctx.listDetectedMedia(1))[0].downloadUrl,'https://www.youtube.com/watch?v=abcdefghijk');
 await ctx.recordMedia({tabId:1,statusCode:206,url:'https://rr.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4',responseHeaders:[{name:'content-type',value:'application/octet-stream'}]});
 assert.equal(vm.runInContext('mediaByTab.get(1).length',ctx),1);
 changed(1,{url:url+'&list=test'});assert.equal(vm.runInContext('mediaByTab.get(1).length',ctx),1);
 url='https://www.youtube.com/shorts/12345678901';changed(1,{url});assert.equal((await ctx.listDetectedMedia(1))[0].downloadUrl,'https://www.youtube.com/watch?v=12345678901');
 assert.equal(ctx.youtubePage('https://youtube.com.evil.test/watch?v=abcdefghijk'),null);
});
test('format list preserves high quality video and adds audio without storyboard entries',()=>{
 const formats=mediaFormats([{format_id:'137',url:'https://media',vcodec:'avc1.640028',acodec:'none',height:1080,fps:60,ext:'mp4',filesize:42},{format_id:'401',manifest_url:'https://manifest',vcodec:'av01',acodec:'none',height:2160,ext:'mp4',dynamic_range:'HDR10'},{format_id:'140',url:'https://audio',vcodec:'none',acodec:'mp4a',ext:'m4a'},{format_id:'sb',url:'https://storyboard',vcodec:'none',acodec:'none',ext:'mhtml'}]);
 assert.equal(formats.length,3);assert.equal(formats[0].id,'401+bestaudio/401');assert.match(formats[0].label,/2160p.*HDR10/);assert.match(formats[1].label,/1080p.*60fps/);assert.equal(formats[1].size,null);assert.equal(formats[2].id,'140');
});
test('X discovery replaces noisy request fragments with the current visible posts', async () => {
  let visible = [{ url: 'https://x.com/user/status/123', title: 'Visible video' }];
  const url = 'https://x.com/home';
  const api = {
    tabs: { get: async () => ({ url }), sendMessage: async () => ({ url, media: visible }), onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    webRequest: { onHeadersReceived: { addListener() {} } }, runtime: { onMessage: { addListener() {} } }
  };
  const ctx = vm.createContext({ URL, chrome: api, browser: api });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/media-sniffer.js'), 'utf8'), ctx);
  for (const suffix of ['vid/one.mp4', 'aud/two.mp4', 'pl/master.m3u8']) {
    await ctx.recordMedia({ tabId: 1, statusCode: 206, url: 'https://video.twimg.com/amplify_video/123/' + suffix });
  }
  let media = await ctx.listDetectedMedia(1);
  assert.equal(media.length, 1);
  assert.equal(media[0].downloadUrl, visible[0].url);
  assert.equal(media[0].size, null);
  visible = [{ url: 'https://x.com/other/status/456', title: 'After scrolling' }];
  assert.equal((await ctx.listDetectedMedia(1))[0].url, visible[0].url);
  visible = [];
  assert.equal((await ctx.listDetectedMedia(1)).length, 0);
  api.tabs.sendMessage = async () => { throw new Error('Tab navigated'); };
  assert.equal((await ctx.listDetectedMedia(1)).length, 0);
});
test('clearing media stays empty until rescan and discards a request pending during clear', async () => {
  let receive, releaseTab;
  let pendingTab = false;
  const api = {
    tabs: { get: async () => {
      if (pendingTab) return new Promise(resolve => { releaseTab = resolve; });
      return { url: 'https://example.com/video', title: 'Fixture' };
    }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    webRequest: { onHeadersReceived: { addListener() {} } },
    runtime: { onMessage: { addListener: callback => { receive = callback; } } }
  };
  const ctx = vm.createContext({ URL, chrome: api });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/media-sniffer.js'), 'utf8'), ctx);
  const message = type => new Promise(resolve => receive({ type, tabId: 1 }, {}, resolve));
  await ctx.recordMedia({ tabId: 1, url: 'https://example.com/old.mp4', statusCode: 200 });
  assert.equal((await message('media-list')).media.length, 1);
  pendingTab = true;
  const pending = ctx.recordMedia({ tabId: 1, url: 'https://example.com/pending.mp4', statusCode: 200 });
  await message('media-clear');
  releaseTab({ url: 'https://example.com/video' });
  await pending;
  pendingTab = false;
  assert.equal((await message('media-list')).cleared, true);
  assert.equal((await message('media-list')).media.length, 0);
  await message('media-rescan');
  assert.equal((await message('media-list')).media.length, 0);
  await ctx.recordMedia({ tabId: 1, url: 'https://example.com/new.mp4', statusCode: 200 });
  assert.equal((await message('media-list')).media[0].url, 'https://example.com/new.mp4');
});
