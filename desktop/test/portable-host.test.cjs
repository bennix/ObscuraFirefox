const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const { secureStore } = require('../secure-store.cjs');
test('Windows credentials round-trip with DPAPI without plaintext on disk', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-dpapi-'));
  const original = process.env.APPDATA; process.env.APPDATA = root;
  const attrs = ['-a','fixture-account','-s','obscura-test'];
  try {
    await secureStore('', ['add-generic-password',...attrs,'-w','fixture-only-secret']);
    assert.equal((await secureStore('', ['find-generic-password',...attrs])).stdout, 'fixture-only-secret');
    const folder = path.join(root,'Obscura Firefox/secrets');
    for (const name of await fs.readdir(folder)) assert.equal((await fs.readFile(path.join(folder,name))).includes(Buffer.from('fixture-only-secret')), false);
    await secureStore('', ['delete-generic-password',...attrs]);
    await assert.rejects(secureStore('', ['find-generic-password',...attrs]));
  } finally { if(original===undefined)delete process.env.APPDATA;else process.env.APPDATA=original; await fs.rm(root,{recursive:true,force:true}); }
});
test('Windows native wrapper forwards Unicode paths and binary stdin/stdout', { skip: process.platform !== 'win32' || !process.env.OBSCURA_HOST_WRAPPER }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'obscura host 测试 '));
  try {
    const bin = path.join(root,'bin'), scripts=path.join(root,'firefox'), profile=path.join(root,'profile space'), manifests=path.join(profile,'NativeMessagingHosts');
    await Promise.all([fs.mkdir(bin),fs.mkdir(scripts),fs.mkdir(manifests,{recursive:true})]);
    await fs.copyFile(process.execPath,path.join(bin,'node.exe'));
    const wrapper=path.join(bin,'host.exe');await fs.copyFile(process.env.OBSCURA_HOST_WRAPPER,wrapper);
    await fs.writeFile(path.join(scripts,'native-host.cjs'), "process.stdout.write(JSON.stringify({directory:process.argv[2]}));");
    const {stdout}=await execute(wrapper,[path.join(manifests,'ai.obscura.workspace.json'),'workspace@obscura.local']);
    assert.equal(JSON.parse(stdout).directory,profile);
    await fs.writeFile(path.join(scripts,'native-host.cjs'), 'process.stdin.pipe(process.stdout);');
    const child=require('node:child_process').spawn(wrapper,[path.join(manifests,'ai.obscura.workspace.json')]);
    const data=Buffer.from([0,255,10,13,42]);const chunks=[];
    child.stdout.on('data', chunk=>chunks.push(chunk));
    const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Host exited '+code)));});
    child.stdin.end(data);await done;assert.deepEqual(Buffer.concat(chunks),data);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
