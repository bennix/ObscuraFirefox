const fs = require('node:fs/promises');
const path = require('node:path');
async function prepareExtension(destination, bridge = null) {
  if (bridge) {
    const origin = new URL(bridge.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !bridge.token) throw new Error('Invalid local bridge');
  }
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.cp(path.join(__dirname, '../extension'), destination, { recursive: true });
  for (const file of ['manifest.json', 'background.js', 'platform.js', 'selection.js', 'panel-bootstrap.js', 'native-api.js', 'native-schema.json', 'theme.css', 'localization.js', 'media-context.js', 'download-error.html', 'download-error.js']) await fs.copyFile(path.join(__dirname, file), path.join(destination, file));
  // Shared detection code uses the promise-capable API in Firefox as well.
  await fs.writeFile(path.join(destination, 'search-engines.js'), `globalThis.SEARCH_ENGINES=${JSON.stringify(require('../navigation.cjs').engines)};\n`);
  await fs.mkdir(path.join(destination, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 64, 128]) await fs.copyFile(path.join(__dirname, `branding/generated/default${size}.png`), path.join(destination, 'icons', `${size}.png`));
  const media = await fs.readFile(path.join(destination, 'media-sniffer.js'), 'utf8');
  await fs.writeFile(path.join(destination, 'media-sniffer.js'), media.replaceAll('chrome.', 'browser.'));
  await fs.writeFile(path.join(destination, 'bridge-config.js'), `globalThis.BRIDGE=${JSON.stringify(bridge)};\n`, { mode: 0o600 });
  await fs.chmod(path.join(destination, 'bridge-config.js'), 0o600);
  let html = await fs.readFile(path.join(destination, 'panel.html'), 'utf8');
  html = html.replace('开启后，放宽 X 官网及其子域的 COOP 跨窗口隔离以支持登录回传。非代理 UDP 仍受限。保存后重启应用生效。', 'Firefox 使用原生登录流程。开启后仅为 X 站点放宽抗指纹设置；Claude 等其他站点保持严格保护，WebRTC 始终禁用。切换后重新加载 X 生效。')
    .replace('<li>限制非代理 UDP</li><li>隐藏 WebGL 显卡型号</li><li>禁用离线音频指纹接口</li>', '<li>源码默认禁用 WebRTC</li><li>Firefox 跟踪与指纹保护</li><li>分区 Cookie 与敏感权限限制</li>');
  html = html.replace('</head>', '<link rel="stylesheet" href="theme.css"></head>').replace('Chrome 157 · Stable', 'Firefox · Obscura').replace('验证时暂停保护', 'WebRTC 已禁用').replace('当前 Chrome 页面', '当前 Firefox 页面').replace('跟随系统</option>', '跟随 Firefox / 系统</option>');
  html = html.replace('</body>', '<script src="selection.js"></script></body>');
  if (!bridge) html = html.replace(/<script src="bridge-config.js"><\/script>[\s\S]*?<\/body>/, '<script src="panel-bootstrap.js"></script></body>');
  await fs.writeFile(path.join(destination, 'panel.html'), html);
  return destination;
}
module.exports = { prepareExtension };
