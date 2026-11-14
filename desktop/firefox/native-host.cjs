const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
async function bridgeInfo(directory) {
  const file = path.join(directory, 'launcher.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  const origin = new URL(record.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error('Invalid local bridge');
  return { origin: origin.origin, token: record.token };
}
function serve(input, output, directory) {
  let buffer = Buffer.alloc(0), processing = Promise.resolve();
  const respond = value => {
    const body = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    output.write(Buffer.concat([header, body]));
  };
  input.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (size > 4096) { input.destroy(); return; }
      if (buffer.length < size + 4) return;
      const packet = buffer.subarray(4, size + 4); buffer = buffer.subarray(size + 4);
      processing = processing.then(async () => {
        try {
          const message = JSON.parse(packet.toString());
          if (message.type !== 'bridge') throw new Error('Unsupported native request');
          respond(await bridgeInfo(directory));
        } catch { respond({ error: '本地工作台未启动或连接配置不可用' }); }
      });
    }
  });
}
if (require.main === module) serve(process.stdin, process.stdout, process.argv[2] || path.join(os.homedir(), 'Library/Application Support/Obscura Firefox'));
module.exports = { bridgeInfo, serve };
