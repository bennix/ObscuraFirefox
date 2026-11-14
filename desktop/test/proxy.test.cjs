const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { ProxyTransport, parseSystemProxy } = require('../proxy.cjs');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('system proxy handles HTTPS, SOCKS, PAC and ignores inactive scoped overrides', () => {
  assert.equal(parseSystemProxy('<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 7890\n __SCOPED__ : <dictionary> {\n HTTPSPort : 9999\n }\n}', 'https://zenmux.ai'), 'http://127.0.0.1:7890');
  assert.equal(parseSystemProxy('<dictionary> {\n SOCKSEnable : 1\n SOCKSProxy : 127.0.0.1\n SOCKSPort : 1080\n}', 'https://zenmux.ai'), 'socks5h://127.0.0.1:1080');
  assert.equal(parseSystemProxy('<dictionary> {\n ProxyAutoConfigEnable : 1\n ProxyAutoConfigURLString : https://fixture/proxy.pac\n}', 'https://zenmux.ai'), 'pac+https://fixture/proxy.pac');
  assert.throws(() => parseSystemProxy('<dictionary> {\n ProxyAutoDiscoveryEnable : 1\n}', 'https://zenmux.ai'), /自动发现/);
});

test('AI traffic uses HTTP proxy and fails closed when the proxy disappears', async () => {
  let directRequests = 0, proxyRequests = 0;
  const destination = http.createServer((_, res) => { directRequests++; res.end('direct'); });
  const proxy = http.createServer((req, res) => {
    proxyRequests++;
    assert.match(req.url, /^http:\/\/127\.0\.0\.1:/);
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: proxy-response\n\n');
  });
  await listen(destination); await listen(proxy);
  const proxyURL = `http://127.0.0.1:${proxy.address().port}`;
  const transport = new ProxyTransport({ read: async () => ({ proxy: { mode: 'manual' } }), proxyURL: async () => proxyURL });
  try {
    const url = `http://127.0.0.1:${destination.address().port}/completion`;
    assert.match(await (await transport.fetch(url, { method: 'POST', body: '{}' })).text(), /proxy-response/);
    assert.equal(proxyRequests, 1); assert.equal(directRequests, 0);
    transport.close(); await close(proxy);
    await assert.rejects(transport.fetch(url, { signal: AbortSignal.timeout(2000) }), /代理连接失败/);
    assert.equal(directRequests, 0);
  } finally {
    transport.close();
    if (proxy.listening) await close(proxy);
    await close(destination);
  }
});

test('SOCKS5 proxy carries AI traffic with proxy-side hostname resolution', async () => {
  const destination = http.createServer((_, res) => res.end('socks verified'));
  await listen(destination);
  let requestedHost;
  const sockets = new Set();
  const proxy = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let state = 'greeting', buffer = Buffer.alloc(0);
    function incoming(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (state === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0])); state = 'connect';
      }
      if (state !== 'connect' || buffer.length < 5) return;
      assert.equal(buffer[3], 3);
      const hostLength = buffer[4];
      if (buffer.length < 7 + hostLength) return;
      requestedHost = buffer.subarray(5, 5 + hostLength).toString();
      const port = buffer.readUInt16BE(5 + hostLength);
      const upstream = net.connect(port, '127.0.0.1', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        socket.pipe(upstream).pipe(socket);
      });
      socket.removeListener('data', incoming); state = 'tunnel';
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
    }
    socket.on('data', incoming);
  });
  await listen(proxy);
  const transport = new ProxyTransport({ read: async () => ({ proxy: { mode: 'manual' } }), proxyURL: async () => `socks5://127.0.0.1:${proxy.address().port}` });
  try {
    const result = await transport.fetch(`http://proxy-resolved.invalid:${destination.address().port}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(await result.text(), 'socks verified');
    assert.equal(requestedHost, 'proxy-resolved.invalid');
  } finally {
    transport.close(); for (const socket of sockets) socket.destroy();
    await close(proxy); await close(destination);
  }
});
