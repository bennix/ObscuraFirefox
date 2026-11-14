(async function initialize() {
  try {
    globalThis.BRIDGE = await browser.runtime.sendNativeMessage('ai.obscura.workspace', { type: 'bridge' });
    if (!BRIDGE?.origin || !BRIDGE?.token) throw new Error('请从 Obscura 应用入口启动浏览器');
  } catch (error) {
    document.getElementById('status').textContent = error.message;
    setTimeout(initialize, 1500); return;
  }
  for (const file of ['platform.js', 'vendor/marked.js', 'vendor/purify.js', 'vendor/katex.js', 'richtext.js', 'panel.js', 'downloads.js', 'attachments.js', 'reading.js', 'selection.js', 'localization.js']) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = file;
      script.onload = resolve; script.onerror = () => reject(new Error('工作台资源加载失败：' + file));
      document.body.append(script);
    });
  }
  window.dispatchEvent(new Event('obscura-workspace-ready'));
})().catch(error => { document.getElementById('status').textContent = error.message; });
