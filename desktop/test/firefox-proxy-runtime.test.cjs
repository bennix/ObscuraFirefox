const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const backendRoot = process.env.OBSCURA_TEST_BACKEND || path.join(__dirname, '..');
const { start } = require(path.join(backendRoot, 'firefox/start.cjs'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = result => JSON.parse(result.content[0].text);
const listen = (server, host = '127.0.0.1') => new Promise(resolve => server.listen(0, host, resolve));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); for (const socket of server.fixtureSockets || []) socket.destroy(); server.close(resolve); });

for (const {scheme, authenticated} of [{scheme:'http'}, {scheme:'http',authenticated:true}, {scheme:'socks5'}, {scheme:'socks5',authenticated:true}, {scheme:'socks4'}, ...(process.env.OBSCURA_CERTUTIL ? [{scheme:'https'}] : [])]) test(`Firefox manual ${scheme}${authenticated ? ' authenticated' : ''} proxy routes traffic and fails closed`, { skip: !process.env.OBSCURA_FIREFOX_BIN, timeout: 150000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-proxy-runtime-'));
  const manifest = path.join(os.homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts/ai.obscura.workspace.json');
  let previous, app;
  try { previous = await fs.readFile(manifest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let direct = 0;
  const requests = [], proxyErrors = [];
  const origin = http.createServer((req, res) => { direct++; res.end('<title>DIRECT CONNECTION</title>'); });
  let proxy;
  if (['http', 'https'].includes(scheme)) {
    let tls;
    if (scheme === 'https') {
      const key = path.join(directory, 'proxy-key.pem'), cert = path.join(directory, 'proxy-cert.pem');
      const caKey = path.join(directory, 'ca-key.pem'), ca = path.join(directory, 'ca.pem'), csr = path.join(directory, 'proxy.csr');
      const config = path.join(directory, 'openssl.cnf'), leaf = path.join(directory, 'leaf.cnf'), profile = path.join(directory, 'profile');
      await fs.writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Obscura Test CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
      await fs.writeFile(leaf, 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
      execFileSync('/usr/bin/openssl', ['req', '-x509', '-sha256', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-days', '1', '-config', config], { stdio: 'pipe' });
      execFileSync('/usr/bin/openssl', ['req', '-new', '-sha256', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=localhost'], { stdio: 'pipe' });
      execFileSync('/usr/bin/openssl', ['x509', '-req', '-sha256', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '1', '-extfile', leaf], { stdio: 'pipe' });
      await fs.mkdir(profile);
      execFileSync(process.env.OBSCURA_CERTUTIL, ['-N', '--empty-password', '-d', 'sql:' + profile], { stdio: 'pipe' });
      execFileSync(process.env.OBSCURA_CERTUTIL, ['-A', '-n', 'Obscura fixture CA', '-t', 'C,,', '-i', ca, '-d', 'sql:' + profile], { stdio: 'pipe' });
      execFileSync(process.env.OBSCURA_CERTUTIL, ['-A', '-n', 'Obscura fixture proxy', '-t', ',,', '-i', cert, '-d', 'sql:' + profile], { stdio: 'pipe' });
      execFileSync(process.env.OBSCURA_CERTUTIL, ['-V', '-n', 'Obscura fixture proxy', '-u', 'V', '-d', 'sql:' + profile], { stdio: 'pipe' });
      tls = { key: await fs.readFile(key), cert: await fs.readFile(cert) };
    }
    const createServer = handler => tls ? https.createServer(tls, handler) : http.createServer(handler);
    proxy = createServer((req, res) => { if (authenticated && req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('fixture-user:fixture-pass').toString('base64')) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="fixture"' }); res.end(); return; } requests.push(req.url); res.setHeader('Content-Type', 'text/html'); res.end('<title>Via Obscura proxy</title>'); });
    proxy.on('tlsClientError', error => proxyErrors.push(error.code));
    proxy.on('connect', (req, socket) => { requests.push('CONNECT ' + req.url); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  } else {
    proxy = net.createServer(socket => {
      proxy.fixtureSockets.add(socket); socket.on('close', () => proxy.fixtureSockets.delete(socket)); socket.on('error', () => {});
      let stage = scheme === 'socks4' ? 'socks4' : 'greeting', buffered = Buffer.alloc(0);
      socket.on('data', data => {
        buffered = Buffer.concat([buffered, data]);
        if (stage === 'socks4') {
          const end = buffered.indexOf(0, 8);
          if (buffered.length < 9 || end < 0) return;
          assert.equal(buffered[0], 4); assert.equal(buffered[1], 1);
          const host = [...buffered.subarray(4, 8)].join('.'), port = buffered.readUInt16BE(2);
          requests.push(`socks4://${host}:${port}`);
          buffered = buffered.subarray(end + 1); socket.write(Buffer.from([0, 90, 0, 80, 127, 0, 0, 1])); stage = 'http';
        }
        if (stage === 'greeting') {
          if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return;
          assert.equal(buffered[0], 5);
          if (authenticated) assert.ok(buffered.subarray(2, 2 + buffered[1]).includes(2), 'SOCKS5 client offers username/password authentication');
          buffered = buffered.subarray(2 + buffered[1]); socket.write(Buffer.from([5, authenticated ? 2 : 0])); stage = authenticated ? 'auth' : 'request';
        }
        if (stage === 'auth') {
          if (buffered.length < 2 || buffered.length < 3 + buffered[1]) return;
          const userLength = buffered[1], passwordLength = buffered[2 + userLength];
          if (buffered.length < 3 + userLength + passwordLength) return;
          assert.equal(buffered.subarray(2, 2 + userLength).toString(), 'fixture-user');
          assert.equal(buffered.subarray(3 + userLength, 3 + userLength + passwordLength).toString(), 'fixture-pass');
          buffered = buffered.subarray(3 + userLength + passwordLength); socket.write(Buffer.from([1, 0])); stage = 'request';
        }
        if (stage === 'request') {
          if (buffered.length < 5) return;
          const length = buffered[3] === 1 ? 4 : buffered[3] === 3 ? 1 + buffered[4] : 16;
          if (buffered.length < 4 + length + 2) return;
          const host = buffered[3] === 1 ? [...buffered.subarray(4, 8)].join('.') : buffered.subarray(5, 4 + length).toString();
          const port = buffered.readUInt16BE(4 + length);
          requests.push(`socks5://${host}:${port}`);
          buffered = buffered.subarray(6 + length); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); stage = 'http';
        }
        if (stage === 'http' && buffered.includes(Buffer.from('\r\n\r\n'))) {
          const body = '<title>Via Obscura proxy</title>';
          socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); stage = 'done';
        }
      });
    });
    proxy.fixtureSockets = new Set();
  }
  const address = Object.values(os.networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal)?.address;
  assert.ok(address, 'A local network interface is required for the proxy route fixture');
  await listen(origin, address); await listen(proxy);
  t.after(async () => {
    await app?.close(); await close(proxy); await close(origin);
    if (previous) await fs.writeFile(manifest, previous, { mode: 0o600 }); else await fs.rm(manifest, { force: true });
    await fs.rm(directory, { recursive: true, force: true });
  });
  const proxyURL = `${scheme}://${authenticated ? 'fixture-user:fixture-pass@' : ''}127.0.0.1:${proxy.address().port}`;
  const target = `http://${address}:${origin.address().port}/route-check`;
  app = await start({ binary: process.env.OBSCURA_FIREFOX_BIN, directory, testing: true, url: 'about:blank', settings: {
    read: async () => ({ searchEngine: 'google', theme: 'dark', proxy: { mode: 'manual', url: proxyURL } }),
    proxyURL: async () => proxyURL
  } });
  const deadline = Date.now() + 60000;
  while (!app.tools.browserClient.open && Date.now() < deadline) await pause(100);
  assert.equal(app.tools.browserClient.open, true);
  const navigation = value(await app.tools.call('browser_navigate', { url: target }));
  assert.equal(navigation.url, target);
  if(scheme==='https') assert.deepEqual(proxyErrors, []);
  assert.equal(value(await app.tools.call('browser_snapshot')).title, 'Via Obscura proxy');
  assert.ok(requests.includes(['http', 'https'].includes(scheme) ? target : `${scheme}://${address}:${origin.address().port}`));
  assert.equal(direct, 0, 'No direct startup or navigation request reaches the origin');
  await close(proxy);
  await app.tools.call('browser_navigate', { url: target + '-offline' }).catch(() => {});
  await pause(500);
  assert.equal(direct, 0, 'Unavailable proxy must not fall back to a direct request');
});
