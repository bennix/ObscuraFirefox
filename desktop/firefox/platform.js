globalThis.workspace = {
  standalone: true,
  nativeTheme: true,
  nativeDownloads: true,
  download: args => browser.runtime.sendMessage({ type: 'native-download', args }),
  message: data => browser.runtime.sendMessage(data),
  openTab: url => browser.tabs.create({ url }),
  openPanel: () => browser.sidebarAction.close()
};

// Firefox owns the palette; custom themes update an already-open sidebar.
async function syncFirefoxTheme() {
  const win = await browser.windows.getCurrent();
  const theme = await browser.theme.getCurrent(win.id);
  const colors = theme?.colors || {};
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const bg = colors.sidebar || colors.toolbar || (dark ? '#2b2a33' : '#ffffff');
  const ink = colors.sidebar_text || colors.toolbar_text || (dark ? '#fbfbfe' : '#15141a');
  const style = document.documentElement.style;
  const palette = { '--bg': bg, '--panel': bg, '--ink': ink,
    '--line': colors.sidebar_border || `color-mix(in srgb, ${ink} 22%, ${bg})`,
    '--muted': `color-mix(in srgb, ${ink} 70%, ${bg})`,
    '--green': colors.sidebar_highlight || colors.button_background_active || (dark ? '#00ddff' : '#0060df'),
    '--selected-ink': colors.sidebar_highlight_text || (dark ? '#15141a' : '#ffffff') };
  for (const [key, value] of Object.entries(palette)) style.setProperty(key, value);
  style.colorScheme = dark ? 'dark' : 'light';
}
browser.theme.onUpdated.addListener(syncFirefoxTheme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncFirefoxTheme);
syncFirefoxTheme().catch(console.error);
document.getElementById('sidepanel').textContent = '关闭侧栏 ×';
document.getElementById('sidepanel').title = '关闭 AI 侧栏（⌘⇧Y 可重新打开）';

const mediaEntry = document.createElement('button');
mediaEntry.id = 'media-entry'; mediaEntry.textContent = '媒体嗅探 / HLS 下载';
document.querySelector('.target').after(mediaEntry);
mediaEntry.onclick = () => document.querySelector('[data-tab="downloads"]').click();
const nativeDownloadsButton = document.createElement('button');
nativeDownloadsButton.id = 'native-downloads'; nativeDownloadsButton.textContent = '打开 Firefox 下载列表 ↗';
nativeDownloadsButton.onclick = () => browser.obscuraNative.openDownloads();
document.getElementById('downloads').prepend(nativeDownloadsButton);
setInterval(async () => {
  try {
    const tab = await browser.runtime.sendMessage({ type: 'active-tab' });
    const result = await browser.runtime.sendMessage({ type: 'media-list', tabId: tab.id });
    mediaEntry.textContent = `媒体嗅探 / HLS 下载 · ${result.media?.length || 0} 个资源`;
  } catch {}
}, 2000);

// Layout preferences hide presentation only; the task observer keeps running.
const auxiliaryRegions = [
  ['page', '.target', '当前网页', 'Current page'],
  ['media', '#media-entry', '媒体嗅探 / HLS 下载', 'Media / HLS downloads'],
  ['observer', '#watch', '任务观察哨', 'Task observer'],
  ['model', '.chat-toolbar', '模型与清空按钮', 'Model and clear button']
];
const auxiliaryKey = 'workspaceAuxiliaryVisibility';
const auxiliaryChinese = browser.i18n.getUILanguage().startsWith('zh');
const auxiliaryBar = document.createElement('div');
auxiliaryBar.id = 'auxiliary-controls';
const auxiliaryToggle = document.createElement('button');
auxiliaryToggle.type = 'button';
const auxiliaryOptions = document.createElement('details');
const auxiliarySummary = document.createElement('summary');
auxiliarySummary.textContent = auxiliaryChinese ? '自定义显示' : 'Customize';
auxiliaryOptions.append(auxiliarySummary);
auxiliaryBar.append(auxiliaryToggle, auxiliaryOptions);
document.querySelector('nav').after(auxiliaryBar);
let auxiliaryVisible = {};
const auxiliaryInputs = new Map();
function renderAuxiliary() {
  for (const [key, selector] of auxiliaryRegions) {
    const visible = auxiliaryVisible[key] === true;
    document.querySelector(selector).classList.toggle('workspace-hidden', !visible);
    auxiliaryInputs.get(key).checked = visible;
  }
  const anyVisible = auxiliaryRegions.some(([key]) => auxiliaryVisible[key] === true);
  auxiliaryToggle.textContent = auxiliaryChinese
    ? (anyVisible ? '隐藏辅助区域 · 专注输出' : '显示辅助区域')
    : (anyVisible ? 'Hide extras · Focus on output' : 'Show extra controls');
  auxiliaryToggle.setAttribute('aria-expanded', String(anyVisible));
}
let auxiliaryRevision = 0;
function saveAuxiliary() {
  auxiliaryRevision++;
  renderAuxiliary();
  browser.storage.local.set({ [auxiliaryKey]: auxiliaryVisible }).catch(console.error);
}
for (const [key, , zh, en] of auxiliaryRegions) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.onchange = () => { auxiliaryVisible[key] = input.checked; saveAuxiliary(); };
  label.append(input, document.createTextNode(auxiliaryChinese ? zh : en));
  auxiliaryInputs.set(key, input);
  auxiliaryOptions.append(label);
}
auxiliaryToggle.onclick = () => {
  const visible = !auxiliaryRegions.some(([key]) => auxiliaryVisible[key] === true);
  auxiliaryVisible = Object.fromEntries(auxiliaryRegions.map(([key]) => [key, visible]));
  saveAuxiliary();
};
renderAuxiliary();
browser.storage.local.get(auxiliaryKey).then(saved => {
  if (auxiliaryRevision) return;
  auxiliaryVisible = saved[auxiliaryKey] || {};
  renderAuxiliary();
}).catch(console.error);
