const preparingPDFs = new Map();
function replayImagePaste({ files, text, token }) {
  globalThis.__obscuraPendingPDF?.cancel();
  const editor = document.querySelector(`[data-obscura-paste="${token}"]`);
  if (!editor) throw new Error('输入框已变化，请重新粘贴');
  // Construct clipboard data in the page's realm so Gecko lets the site read it.
  const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true, composed: true });
  for (const file of files) {
    const bytes = Uint8Array.from(atob(file.data), value => value.charCodeAt(0));
    event.clipboardData.items.add(new File([bytes], file.name, { type: file.mime }));
  }
  for (const [type, value] of text) event.clipboardData.setData(type, value);
  editor.focus();
  editor.dispatchEvent(event);
  return true;
}
function pendingPDFUpload({ file, token, cancel }) {
  if (cancel) {
    if (globalThis.__obscuraPendingPDF?.token === token) globalThis.__obscuraPendingPDF?.cancel();
    return;
  }
  if (document.documentElement.getAttribute('data-obscura-pdf-upload') !== token) throw new Error('网页已切换，请重新粘贴');
  globalThis.__obscuraPendingPDF?.cancel();
  const prototype = HTMLInputElement.prototype;
  const click = prototype.click;
  const showPicker = prototype.showPicker;
  let timer;
  let active = true;
  function finish(status) {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    if (prototype.click === patchedClick) prototype.click = click;
    if (prototype.showPicker === patchedShowPicker) prototype.showPicker = showPicker;
    window.removeEventListener('click', capture, true);
    delete globalThis.__obscuraPendingPDF;
    window.dispatchEvent(new CustomEvent('obscura-pdf-upload-status', { detail: JSON.stringify({ token, status }) }));
  }
  function attach(input) {
    if (!active || !(input instanceof HTMLInputElement) || input.type !== 'file' || input.disabled || input.webkitdirectory || input.files.length) return false;
    const accept = input.accept.toLowerCase().split(',').map(value => value.trim());
    if (input.accept && !accept.some(value => ['.pdf', 'application/pdf', 'application/*', '*/*'].includes(value))) return false;
    const bytes = Uint8Array.from(atob(file.data), value => value.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file.name, { type: 'application/pdf' }));
    input.files = transfer.files;
    finish('uploaded');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function patchedClick(...args) { if (!attach(this)) return click.apply(this, args); }
  function patchedShowPicker(...args) { if (!attach(this)) return showPicker.apply(this, args); }
  function capture(event) {
    if (attach(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  prototype.click = patchedClick;
  if (showPicker) prototype.showPicker = patchedShowPicker;
  window.addEventListener('click', capture, true);
  timer = setTimeout(() => finish('expired'), 120000);
  globalThis.__obscuraPendingPDF = { token, cancel: () => finish('cancelled') };
  return true;
}
browser.runtime.onMessage.addListener((message, sender) => {
  if (!['obscura-image-pdf', 'obscura-image-original', 'obscura-pdf-prepare-upload', 'obscura-pdf-cancel-upload', 'obscura-pdf-reveal'].includes(message?.type)) return;
  if (sender.id !== browser.runtime.id || !sender.tab || !/^https?:/.test(sender.url || '')) return Promise.reject(new Error('图片转换仅支持网页粘贴'));
  if (message.type === 'obscura-image-pdf') return ObscuraImagePDF.convert(message.files);
  if (message.type === 'obscura-pdf-reveal') return browser.obscuraNative.revealPastedPDF(sender.tab.id, sender.url);
  const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
  if (message.type === 'obscura-pdf-cancel-upload') {
    if (preparingPDFs.get(sender.tab.id) === message.token) preparingPDFs.delete(sender.tab.id);
    return browser.scripting.executeScript({ target, world: 'MAIN', func: pendingPDFUpload, args: [{ token: message.token, cancel: true }] });
  }
  if (message.type === 'obscura-pdf-prepare-upload') {
    if (!/^[0-9a-f]{32}$/.test(message.token || '')) return Promise.reject(new Error('PDF 上传标识无效'));
    return (async () => {
      preparingPDFs.set(sender.tab.id, message.token);
      try {
        const saved = await browser.obscuraNative.preparePastedPDF(sender.tab.id, sender.url, JSON.stringify(message.file));
        if (preparingPDFs.get(sender.tab.id) !== message.token) return { cancelled: true };
        await browser.scripting.executeScript({ target, world: 'MAIN', func: pendingPDFUpload, args: [{ file: message.file, token: message.token }] });
        if (preparingPDFs.get(sender.tab.id) !== message.token) {
          await browser.scripting.executeScript({ target, world: 'MAIN', func: pendingPDFUpload, args: [{ token: message.token, cancel: true }] });
          return { cancelled: true };
        }
        return saved;
      } finally {
        if (preparingPDFs.get(sender.tab.id) === message.token) preparingPDFs.delete(sender.tab.id);
      }
    })();
  }
  if (!/^[0-9a-f]{32}$/.test(message.token || '') || !Array.isArray(message.files) || message.files.length > 10 || message.files.some(file => typeof file.data !== 'string' || file.data.length > 24 * 1024 * 1024)) return Promise.reject(new Error('图片数据无效或文件过大'));
  return browser.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] }, world: 'MAIN', func: replayImagePaste, args: [{ files: message.files, text: message.text, token: message.token }] });
});
