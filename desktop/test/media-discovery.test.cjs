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
