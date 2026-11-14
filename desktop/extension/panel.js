const $ = id => document.getElementById(id);
let messages = [], config, busy = false, activeTab = {}, png = '';
async function request(endpoint, data) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(BRIDGE.origin + endpoint, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'X-Obscura-Token': BRIDGE.token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(data === undefined ? 15000 : 180000)
      });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(result.error || '本地服务请求失败');
        error.permanent = true;
        throw error;
      }
      return result;
    } catch (error) {
      if (data !== undefined || error.permanent || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
function status(value, error = false) { $('status').textContent = value; $('status').classList.toggle('error', error); }
function showNetwork(network = {}) {
  let label = navigator.onLine ? '网络在线' : '网络离线';
  if (network.status === 'retrying') label = `${network.source === 'browser' ? '网页' : 'AI'} 重连 ${network.attempt}/3 · ${Math.ceil(network.delayMs / 1000)}秒后`;
  if (network.status === 'connected') label = network.source === 'browser' ? '网页已连接' : 'AI 已连接';
  if (network.mode === 'buffered' && network.source !== 'browser') label += ' · 普通响应';
  $('network-state').textContent = label;
  $('network-state').classList.toggle('error', !navigator.onLine || network.status === 'retrying');
}
window.addEventListener('online', () => showNetwork());
window.addEventListener('offline', () => showNetwork());
function showWatch(state) {
  if (!state.task) return;
  const task = state.task;
  const names = { running: '执行中', checking: '正在验收', complete: '验收通过', continue: '继续补足', needs_user: '需要协助', limit: '达到步数上限', stopped: '已停止', error: '执行异常', interrupted: '上次任务中断' };
  $('watch-state').textContent = `${names[task.status] || task.status} · ${task.steps || 0}/80 步`;
  $('watch-reason').textContent = task.reason || '正在核对完成度';
  $('watch-checks').replaceChildren(...(task.checks || []).map(check => { const li = document.createElement('li'); li.textContent = `${check.passed ? '✓' : '○'} ${check.item}`; return li; }));
}
async function run(task) {
  try { status('正在执行…'); await task(); status('就绪'); }
  catch (error) { status(error.message, true); }
}
async function target() { activeTab = await workspace.message({ type: 'active-tab' }); $('target').textContent = activeTab.title || activeTab.url || '请先打开一个网页'; return activeTab; }
async function mcp(name, args = {}) {
  await target();
  const result = await request('/mcp', { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args }, tabUrl: activeTab.url });
  if (result.error) throw new Error(result.error.message); return result.result;
}
const text = result => result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
function switchTab(id) {
  document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== id; });
  document.querySelectorAll('nav button').forEach(el => el.classList.toggle('selected', el.dataset.tab === id));
  $('watch').hidden = id !== 'chat';
}
document.querySelectorAll('nav button').forEach(button => { button.onclick = () => switchTab(button.dataset.tab); });
$('sidepanel').onclick = () => workspace.openPanel().catch(error => status(error.message, true));
async function googleAccount(path) {
  await target();
  let destination = 'https://www.google.com/';
  try { const url = new URL(activeTab.url); if (/(^|\.)(youtube\.com|google\.com)$/.test(url.hostname)) destination = url.href; } catch {}
  const url = new URL('https://accounts.google.com/' + path);
  url.searchParams.set('continue', destination); url.searchParams.set('hl', 'zh-CN');
  await workspace.openTab(url.href);
}
$('x-login').onclick = () => run(async () => { if (!workspace.standalone) throw new Error('请在独立应用中使用 X 登录'); const state = await request('/diagnostics/start', {}); $('login-log-state').textContent = state.writeError || '日志文件 · ' + state.file; await workspace.message({ type: 'x-login' }); });
$('open-login-log').onclick = () => run(() => workspace.message({ type: 'open-login-log' }));
$('google-login').onclick = () => run(() => googleAccount('AddSession'));
$('google-switch').onclick = () => run(() => googleAccount('AccountChooser'));
function models(list, selected) {
  for (const id of ['model', 'default-model']) {
    $(id).replaceChildren(...list.map(name => { const option = document.createElement('option'); option.value = option.textContent = name; return option; }));
    if (list.includes(selected)) $(id).value = selected;
  }
}
function settingsUI(value) {
  $('auth-compatibility').checked = value.authCompatibility === true;
  config = value; models(value.models, value.model); $('models').value = value.models.join('\n');
  applyTheme(value.theme || 'dark');
  $('search-engine').value = value.searchEngine || 'google';
  $('translation-language').value = value.translationLanguage || '简体中文';
  $('api-key').value = ''; $('api-key').placeholder = value.hasKey ? '••••••••••••（已保存；输入可替换）' : '输入 ZenMux API Key';
  $('key-state').textContent = value.hasKey ? '已安全保存到 macOS 钥匙串，真实 Key 不会回传到界面。' : '尚未配置 API Key';
  $('proxy-mode').value = value.proxy?.mode || 'system';
  $('proxy-url').value = '';
  $('proxy-url').placeholder = value.proxy?.url || '例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080';
}
let themePreference = 'dark';
function applyTheme(preference) {
  themePreference = preference;
  const resolved = preference === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : preference;
  if (!workspace.nativeTheme) document.documentElement.dataset.theme = resolved;
  $('theme').value = preference;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePreference === 'system') applyTheme('system'); });
window.addEventListener('message', event => {
  if (event.source === parent && event.data?.type === 'obscura-theme') applyTheme(event.data.theme);
});
$('theme').onchange = () => run(async () => {
  const theme = $('theme').value;
  await request('/settings', { theme }); applyTheme(theme);
  if (workspace.standalone) await workspace.message({ type: 'appearance', theme });
});
$('auth-compatibility').onchange = () => run(async () => { await request('/settings', { authCompatibility: $('auth-compatibility').checked }); status('登录兼容设置已保存，重启应用后生效'); });
$('search-engine').onchange = () => run(() => request('/settings', { searchEngine: $('search-engine').value }));
$('models').oninput = () => { const values = [...new Set($('models').value.split('\n').map(x => x.trim()).filter(Boolean))]; const old = $('default-model').value; const options = values.map(name => { const option = document.createElement('option'); option.value = option.textContent = name; return option; }); $('default-model').replaceChildren(...options); if (values.includes(old)) $('default-model').value = old; };
$('save-settings').onclick = () => run(async () => {
  const values = $('models').value.split('\n').map(x => x.trim()).filter(Boolean);
  settingsUI(await request('/settings', {
    models: values, model: $('default-model').value, apiKey: $('api-key').value,
    authCompatibility: $('auth-compatibility').checked, searchEngine: $('search-engine').value, translationLanguage: $('translation-language').value,
    proxyMode: $('proxy-mode').value, proxyURL: $('proxy-url').value, theme: $('theme').value
  }));
  const result = await workspace.message({ type: 'apply-proxy' });
  if (result.error) throw new Error(result.error);
});
$('test-model').onclick = () => run(async () => {
  $('model-test-state').textContent = '正在测试 Key 和默认模型…';
  const result = await request('/model-test', { model: $('default-model').value, apiKey: $('api-key').value });
  $('model-test-state').textContent = result.ok
    ? `可用。模型 ${result.model} 已返回：${result.reply || '（空回复）'}`
    : `失败（HTTP ${result.status}）：${result.message}`;
});
$('delete-key').onclick = () => run(async () => {
  if (!confirm('删除本地钥匙串中保存的 ZenMux API Key？')) return;
  settingsUI(await request('/settings', { models: config.models, model: config.model, deleteKey: true }));
});
function renderChat() {
  const visible = messages.filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content);
  if (!visible.length) return;
  const conversation = $('conversation');
  const previousScroll = conversation.scrollTop;
  const follow = conversation.scrollHeight - previousScroll - conversation.clientHeight < 80;
  conversation.replaceChildren(...visible.map(message => {
    const item = document.createElement('div'); item.className = 'message ' + message.role;
    const role = document.createElement('span'); role.className = 'role'; role.textContent = message.role === 'user' ? 'YOU' : 'OBSCURA AI';
    const content = document.createElement('div');
    if (message.role === 'assistant') {
      content.className = 'markdown-body';
      renderRichText(content, message.content);
    } else content.textContent = message.content;
    item.append(role, content);
    appendMessageAttachments(item, message.attachments);
    return item;
  }));
  conversation.scrollTop = follow ? conversation.scrollHeight : previousScroll;
}
let renderTimer;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; renderChat(); }, 50);
}
async function streamChat(input) {
  const response = await fetch(BRIDGE.origin + '/chat', {
    method: 'POST', headers: { 'X-Obscura-Token': BRIDGE.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, stream: true })
  });
  if (!response.ok) {
    const error = new Error((await response.json()).error || 'AI 请求失败');
    error.permanent = true;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const indexes = new Map();
  let buffer = '', complete = false;
  function receive(event) {
    if (event.type === 'assistant-start') {
      indexes.set(event.messageId, messages.length);
      messages.push({ role: 'assistant', content: '' });
    }
    const index = indexes.get(event.messageId);
    if (event.type === 'assistant-delta') { messages[index].content += event.delta; scheduleRender(); }
    if (event.type === 'assistant-reset') { messages[index].content = ''; scheduleRender(); }
    if (event.type === 'assistant-end') { messages[index].content = event.message.content || ''; scheduleRender(); }
    if (event.type === 'network') showNetwork(event);
    if (event.type === 'done') { messages = event.messages; renderChat(); complete = true; }
    if (event.type === 'error') throw new Error(event.error);
  }
  try {
    while (true) {
      let timer;
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('流式连接等待超时')), 45000); })
      ]).finally(() => clearTimeout(timer));
      const { value, done } = next;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) receive(JSON.parse(line));
      }
    }
    if (!complete) throw new Error('流式连接中断');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function recoverChat(requestId) {
  status('正在恢复连接与任务进度…');
  let failures = 0;
  while (true) {
    let state;
    try { state = await request('/chat-state'); failures = 0; }
    catch (error) {
      if (++failures >= 6) throw new Error('暂时无法连接本地任务，已保留收到的内容。请恢复网络后检查任务状态。');
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
    if (state.requestId !== requestId) throw new Error('本地任务已中断，已保留收到的内容。');
    if (state.status === 'running') {
      messages = state.messages; renderChat();
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    const partial = state.messages.at(-1)?.content;
    messages = state.history;
    if (state.status === 'error' && partial && !messages.some(message => message.content === partial)) {
      messages.push({ role: 'assistant', content: `已收到的部分内容，尚未验收\n\n${partial}` });
    }
    renderChat();
    if (state.status === 'error') throw new Error(state.error);
    return;
  }
}
function setBusy(value) {
  busy = value;
  $('send').disabled = value;
  $('clear-chat').disabled = value;
  $('stop').hidden = !value;
}
async function send(prompt) {
  if (busy || !prompt.trim() && !pendingAttachments.length) return;
  if (!config?.hasKey) { switchTab('settings'); status('请先保存 ZenMux API Key', true); return; }
  setBusy(true);
  const batch = [...pendingAttachments];
  const poll = setInterval(async () => {
    try { const state = await request('/health'); showWatch(state); showNetwork(state.network); $('tool-events').textContent = state.events.map(e => `${e.status === 'done' ? '✓' : e.status === 'error' ? '!' : '…'} ${e.tool}`).join('\n'); } catch {}
  }, 900);
  try {
    status(batch.length ? '正在准备附件…' : '正在发送…');
    const references = await uploadAttachments(batch);
    messages.push({ role: 'user', content: prompt.trim() || '请分析附件。', ...(references.length ? { attachments: references } : {}) });
    consumeAttachments(batch);
    renderChat(); $('prompt').value = '';
    status('AI 正在读取与操作页面…'); await target();
    const requestId = crypto.randomUUID();
    try { await streamChat({ messages, model: $('model').value, tabUrl: activeTab.url, requestId }); }
    catch (error) { if (error.permanent) throw error; await recoverChat(requestId); }
    showWatch(await request('/health')); status('就绪');
  } catch (error) { status(error.message, true); }
  finally { clearInterval(poll); setBusy(false); }
}
$('chat-form').onsubmit = event => { event.preventDefault(); send($('prompt').value); };
$('prompt').onkeydown = event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); send($('prompt').value); } };
$('summarize').onclick = () => send('请读取当前网页并用中文总结主要内容。');
$('stop').onclick = () => request('/cancel', {}).catch(error => status(error.message, true));
$('clear-chat').onclick = () => run(async () => {
  await request('/chat-clear', {});
  resetAttachmentCache();
  messages = []; $('conversation').replaceChildren(); $('tool-events').textContent = '';
});
function pageTextFile(name, content) {
  return new File([content], name, { type: 'text/plain' });
}
function dataUrlFile(dataUrl, name) {
  const [head, data] = dataUrl.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'image/png';
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
  return new File([bytes], name, { type: mime });
}
function requirePageText(element) {
  const content = element.textContent.trim();
  if (!content || content.startsWith('等待')) throw new Error('请先读取或执行，再发给 AI');
  return content;
}
$('snapshot').onclick = () => run(async () => { $('page-output').textContent = text(await mcp('browser_snapshot')); });
$('send-page').onclick = () => run(async () => { const content = requirePageText($('page-output')); switchTab('chat'); await send('请根据页面工具读取到的内容回答。\n\n' + content); });
$('attach-page').onclick = () => run(async () => { const content = requirePageText($('page-output')); switchTab('chat'); await addAttachments([pageTextFile('page.txt', content)]); status('页面内容已加入附件，写好问题后发送'); });
$('capture').onclick = () => run(async () => { const result = await mcp('browser_screenshot'); const img = result.content.find(item => item.type === 'image'); png = `data:${img.mimeType};base64,${img.data}`; $('preview').src = png; $('preview').hidden = false; for (const id of ['save-capture', 'send-capture', 'attach-capture']) $(id).hidden = false; });
$('send-capture').onclick = () => run(async () => { if (!png) throw new Error('请先截图'); switchTab('chat'); await addAttachments([dataUrlFile(png, 'page.png')]); await send('请看这张当前网页截图。'); });
$('attach-capture').onclick = () => run(async () => { if (!png) throw new Error('请先截图'); switchTab('chat'); await addAttachments([dataUrlFile(png, 'page.png')]); status('截图已加入附件，写好问题后发送'); });
$('save-capture').onclick = () => { const link = document.createElement('a'); link.href = png; link.download = 'obscura-capture.png'; link.click(); };
for (const action of ['click', 'fill']) $(action).onclick = () => run(async () => {
  const selector = $('selector').value.trim(); if (!selector) throw new Error('请输入 CSS 选择器');
  $('result').textContent = text(await mcp('browser_' + action, { selector, ...(action === 'fill' ? { value: $('value').value } : {}) }));
});
$('evaluate').onclick = () => run(async () => { $('result').textContent = text(await mcp('browser_evaluate', { expression: $('expression').value })); });
$('send-result').onclick = () => run(async () => { const content = requirePageText($('result')); switchTab('chat'); await send('请根据页面工具的执行结果回答。\n\n' + content); });
$('attach-result').onclick = () => run(async () => { const content = requirePageText($('result')); switchTab('chat'); await addAttachments([pageTextFile('result.txt', content)]); status('执行结果已加入附件，写好问题后发送'); });
$('engine-load').onclick = () => run(async () => {
  await target(); if (!activeTab.url) throw new Error('请先打开一个网页');
  await request('/obscura', { tool: 'browser_navigate', arguments: { url: activeTab.url } });
  $('engine-output').textContent = text(await request('/obscura', { tool: 'browser_snapshot' }));
  const result = await request('/obscura', { tool: 'browser_screenshot', arguments: { width: 1280, height: 900 } });
  const image = result.content.find(item => item.type === 'image'); $('engine-preview').src = `data:${image.mimeType};base64,${image.data}`; $('engine-preview').hidden = false;
});
let workspaceInitialized = false;
function initializeWorkspace() {
if (workspaceInitialized) return;
workspaceInitialized = true;
run(async () => {
  settingsUI(await request('/settings')); const state = await request('/health');
  showNetwork(state.network);
  showWatch(state);
  $('version').textContent = `Chrome ${state.chrome} · Stable`;
  if (workspace.standalone) $('version').textContent = `${state.browserEngine || 'Chromium'} ${state.chrome} · ${state.browserEngine === 'Firefox' ? '源码版' : 'Stable'}`;
  $('build-info').textContent = state.browserEngine === 'Firefox' ? `Firefox ${state.chrome} · Obscura 源码构建` : `Stable / Chrome for Testing ${state.chrome} · Obscura 本地源码构建`;
  await target();
  const current = await request('/chat-state');
  if (current.messages.length) {
    messages = current.status === 'done' ? current.history : current.messages;
    renderChat();
  }
  if (current.status === 'running') {
    setBusy(true);
    try { await recoverChat(current.requestId); }
    finally { setBusy(false); }
  }
});
}
window.addEventListener('DOMContentLoaded', initializeWorkspace, { once: true });
window.addEventListener('obscura-workspace-ready', initializeWorkspace, { once: true });
setInterval(() => {
  target().catch(() => {});
  request('/health').then(state => { showWatch(state); showNetwork(state.network); }).catch(() => {});
}, 2000);
