const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const test = require('node:test');
const root=path.resolve(__dirname, '../..');
const backendRoot=process.env.OBSCURA_TEST_BACKEND || path.join(root,'desktop');
const {start}=require(path.join(backendRoot,'firefox/start.cjs'));
test('trusted pointer input opens custom menus and returns updated evidence', { skip: !process.env.OBSCURA_FIREFOX_BIN, timeout: 60000 }, async()=>{
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'obscura-control-'));
const manifest=process.platform === 'darwin' ? path.join(os.homedir(),'Library/Application Support/Mozilla/NativeMessagingHosts/ai.obscura.workspace.json') : process.platform === 'win32' ? path.join(directory,'NativeMessagingHosts/ai.obscura.workspace.json') : path.join(os.homedir(),'.mozilla/native-messaging-hosts/ai.obscura.workspace.json');
const previous=await fs.readFile(manifest).catch(()=>null);
const server=http.createServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end(`<title>Control fixture</title><div role="checkbox" aria-label="Select" aria-checked="false" onmousedown="if(!event.isTrusted)return;this.setAttribute('aria-checked','true');document.querySelector('#menu').hidden=false">Select</div><div id="menu" role="menuitem" aria-label="Unread" hidden onmousedown="if(!event.isTrusted)return;document.querySelector('#result').textContent='Selected unread'">Unread</div><p id="result"></p>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let app;
try{
 app=await start({binary:process.env.OBSCURA_FIREFOX_BIN,directory,testing:true,url:`http://127.0.0.1:${server.address().port}/`,settings:{read:async()=>({proxy:{mode:'system'}})}});
 const deadline=Date.now()+45000;while(!app.tools.browserClient.open&&Date.now()<deadline)await new Promise(r=>setTimeout(r,200));assert.ok(app.tools.browserClient.open);
 const read=async(name,args)=>JSON.parse((await app.tools.call(name,args)).content[0].text);
 let snapshot;for(let i=0;i<30;i++){try{snapshot=await read('browser_snapshot');if(snapshot.controls.length)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const first=snapshot.controls.find(c=>c.label==='Select');assert.ok(first);
 const t=performance.now();const result=await read('browser_click',{ref:first.ref});
 assert.equal(result.snapshot.controls.find(c=>c.label==='Select').checked,'true');
 assert.equal(result.snapshot.controls.find(c=>c.label==='Select').ref,first.ref);
 const menu=result.snapshot.controls.find(c=>c.label==='Unread');assert.ok(menu);
 const next=await read('browser_click',{ref:menu.ref});assert.match(next.snapshot.text,/Selected unread/);
 const refreshed = await read('browser_navigate', {url:`http://127.0.0.1:${server.address().port}/`});
 assert.notEqual(refreshed.ready, 'pending');
 console.log('LIVE_CONTROL_PASS',JSON.stringify({clicks:2,additionalSnapshotCalls:0,elapsedMs:Math.round(performance.now()-t)}));
}finally{await app?.close();await new Promise(r=>server.close(r));if(previous)await fs.writeFile(manifest,previous);else await fs.rm(manifest,{force:true});await fs.rm(directory,{recursive:true,force:true});}
});
