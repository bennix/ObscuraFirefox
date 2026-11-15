const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function navigate({sameURL}) {
 const source=fs.readFileSync(require.resolve('../firefox/background.js'),'utf8');
 const initial='https://fixture.test/#old',url=sameURL?initial:'https://fixture.test/#new';let changed=false,reloads=0,updates=0,listeners=0;
 const events={addListener(){listeners++},removeListener(){listeners--}};
 const browser={tabs:{get:async()=>({id:1,url:changed?url:initial,status:'loading'}),onUpdated:events,onRemoved:events,
 reload:async()=>{reloads++;changed=true},update:async()=>{updates++;changed=true},
 executeScript:async()=>[{epoch:sameURL&&changed?2:1,url:changed?url:initial,ready:'interactive',title:'fixture'}]}};
 const context=vm.createContext({browser,URL,setTimeout,clearTimeout,setInterval:fn=>setInterval(fn,1),clearInterval});
 vm.runInContext(source.slice(source.indexOf('async function execute('),source.indexOf('async function connect(')),context);
 const result=await context.command('browser_navigate',{url},1);
 assert.equal(result.ready,'dom');assert.equal(result.needsSnapshot,true);assert.equal(listeners,0);
 assert.equal(reloads,sameURL?1:0);assert.equal(updates,sameURL?0:1);
}
test('same URL reload completes at DOM readiness without a load-complete event',()=>navigate({sameURL:true}));
test('fragment navigation completes without a loading event',()=>navigate({sameURL:false}));
