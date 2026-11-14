const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const backendRoot = process.env.OBSCURA_TEST_BACKEND || path.join(__dirname, '..');
const { start } = require(path.join(backendRoot, 'firefox/start.cjs'));
const { Settings } = require(path.join(backendRoot, 'settings.cjs'));
const { ProxyTransport } = require(path.join(backendRoot, 'proxy.cjs'));
const { chat } = require(path.join(backendRoot, 'ai.cjs'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = result => JSON.parse(result.content[0].text);

test('live ZenMux controls Firefox and observer verifies every fixture item', { skip: process.env.OBSCURA_LIVE_AI !== '1' || !process.env.OBSCURA_FIREFOX_BIN, timeout: 240000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-live-ai-'));
  const manifest = path.join(os.homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts/ai.obscura.workspace.json');
  let previous, app;
  try { previous = await fs.readFile(manifest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = new Settings(path.join(os.homedir(), 'Library/Application Support/Obscura Firefox'));
  const config = await settings.read();
  const key = await settings.key();
  assert.ok(key, 'Saved ZenMux key is required');
  const transport = new ProxyTransport(settings);
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Obscura AI acceptance fixture</title><h1>本地 AI 操控验收</h1><label>验收标记<input id="marker" placeholder="验收标记"></label><div id="checks">${[1,2,3].map(n=>`<label><input type="checkbox" id="check${n}">检查 ${n}</label>`).join('')}</div><button id="verify" onclick="document.getElementById('result').textContent=document.getElementById('marker').value==='Obscura QA'&&[...document.querySelectorAll('[type=checkbox]')].every(x=>x.checked)?'验收完成：三项检查均通过，标记为 Obscura QA':'尚未完成全部条件'">核对结果</button><p id="result">尚未验收</p>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await app?.close(); transport.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    if(previous) await fs.writeFile(manifest,previous,{mode:0o600}); else await fs.rm(manifest,{force:true});
    await fs.rm(directory,{recursive:true,force:true});
  });
  const url=`http://127.0.0.1:${server.address().port}/`;
  app=await start({binary:process.env.OBSCURA_FIREFOX_BIN,directory,settings,testing:true,url});
  const deadline=Date.now()+60000;
  while(!app.tools.browserClient.open&&Date.now()<deadline) await pause(100);
  assert.ok(app.tools.browserClient.open);
  await app.tools.call('browser_navigate',{url});
  app.tools.currentPage=await app.tools.page();
  let chunks=0, actions=0, verdict;
  await chat({messages:[{role:'user',content:'这是本地测试页。请把验收标记填写为 Obscura QA，勾选检查 1、检查 2、检查 3，然后点击核对结果。读取实际结果，确认三项全部通过后再报告完成。'}],model:config.model,key,tools:app.tools.definitions,maxTools:12,signal:AbortSignal.timeout(180000),fetcher:(url,args)=>transport.fetch(url,args),dispatch:(name,args)=>app.tools.call(name,args),onEvent:event=>{
    if(event.type==='network') console.log('AI network:',event.status,event.attempt);
    if(event.tool) console.log('AI tool:',event.tool,event.status);
    if(event.type==='assistant-delta') chunks++;
    if(event.status==='running') actions++;
    if(event.tool==='观察哨'&&['complete','continue','needs_user'].includes(event.status)) verdict=event;
  }});
  const state=value(await app.tools.call('browser_evaluate',{expression:`({marker:document.getElementById('marker').value,checks:[...document.querySelectorAll('[type=checkbox]')].map(x=>x.checked),result:document.getElementById('result').textContent})`}));
  assert.equal(state.marker,'Obscura QA'); assert.deepEqual(state.checks,[true,true,true]); assert.match(state.result,/验收完成/);
  assert.equal(verdict?.status,'complete'); assert.ok(verdict.checks.length&&verdict.checks.every(item=>item.passed));
  assert.ok(chunks>0,'Actual streaming deltas must be received'); assert.ok(actions>0);
  t.diagnostic(JSON.stringify({model:config.model,streamChunks:chunks,toolActions:actions,observer:verdict.status,checks:verdict.checks.length}));
});
