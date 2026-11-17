(() => {
  if (!['http:', 'https:'].includes(location.protocol)) return;
  let activeDialog;
  let replaying = false;
  let currentNotice;
  function uploadInput(editor) {
    const candidates = [...document.querySelectorAll('input[type="file"]')].filter(input => {
      const accept = input.accept.toLowerCase().split(',').map(value => value.trim());
      return !input.disabled && !input.webkitdirectory && (!input.accept || accept.some(value => ['.pdf', 'application/pdf', 'application/*', '*/*'].includes(value)));
    });
    for (let scope = editor.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
      const local = candidates.filter(input => scope.contains(input));
      if (local.length === 1) return local[0];
      if (local.length > 1) return null;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }
  async function serialize(files) {
    if (files.length > 10 || files.reduce((total, file) => total + file.size, 0) > 32 * 1024 * 1024) throw new Error('每次最多 10 个文件，总量最多 32 MB');
    return Promise.all(files.map(async file => {
      if (file.size > 16 * 1024 * 1024) throw new Error('单个文件最多 16 MB');
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取剪贴板图片'));
        reader.readAsDataURL(file);
      });
      return { name: file.name, mime: file.type, data };
    }));
  }
  function uploadNotice(token, name) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>section{max-width:380px;padding:18px;border:1px solid #c6c9ce;border-radius:12px;background:#fff;color:#202124;font:14px/1.6 system-ui,sans-serif;box-shadow:0 5px 25px #0003}p{margin:0 0 12px}button{font:inherit;padding:6px 10px;margin-right:8px;border:1px solid #c6c9ce;border-radius:6px;background:#fff;color:#202124;cursor:pointer}</style><section role="status"><p></p><button type="button" data-action="reveal">打开 PDF 所在文件夹</button><button type="button" data-action="cancel">取消待上传</button></section>';
    const text = shadow.querySelector('p');
    text.textContent = name + ' 已保存在下载文件夹。点击网站的“上传文件”即可添加 PDF，系统文件选择器也会定位到这份文件。';
    const cancel = async () => { await browser.runtime.sendMessage({ type: 'obscura-pdf-cancel-upload', token }); remove(); };
    function remove() {
      window.removeEventListener('obscura-pdf-upload-status', updated); host.remove();
      if (currentNotice?.token === token) currentNotice = null;
    }
    function updated(event) {
      let detail;
      try { detail = JSON.parse(event.detail); } catch { return; }
      if (detail.token !== token) return;
      if (detail.status === 'expired') text.textContent = '自动添加已超时。PDF 已保存在下载文件夹，点击“打开 PDF 所在文件夹”即可找到。';
      else remove();
    }
    window.addEventListener('obscura-pdf-upload-status', updated);
    shadow.querySelector('[data-action="reveal"]').onclick = async () => {
      try { await browser.runtime.sendMessage({ type: 'obscura-pdf-reveal' }); } catch (error) { text.textContent = error.message; }
    };
    shadow.querySelector('[data-action="cancel"]').onclick = async () => {
      try { await cancel(); remove(); } catch (error) { text.textContent = error.message; }
    };
    currentNotice?.remove();
    currentNotice = { token, cancel, remove };
    document.documentElement.append(host);
  }
  function choose(files, editor, text) {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      dialog { color-scheme:light; box-sizing:border-box; width: min(440px, calc(100vw - 32px)); border:1px solid #d5d7da; border-radius:16px; padding:24px; background:#fff; color:#202124; font:15px/1.6 system-ui,sans-serif; box-shadow:0 12px 50px #0003; }
      dialog::backdrop { background:#0005; } h2 { font-size:19px; margin:0 0 12px; } p { margin:10px 0; } .hint { font-size:13px; color:#595d63; } .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; } button { font:inherit; cursor:pointer; padding:8px 14px; border:1px solid #c6c9ce; border-radius:8px; background:#fff; color:#202124; } button.primary { background:#185abc; color:white; border-color:#185abc; } button:focus-visible { outline:3px solid #8ab4f8; outline-offset:2px; } button:disabled { opacity:.5; cursor:wait; }
    </style><dialog aria-labelledby="title" aria-describedby="hint"><h2 id="title">粘贴图片</h2><p>选择添加到聊天的格式</p><p class="hint" id="hint">PDF 在本地转换，可保留 Canvas 隐私保护。原图会交给网站处理，可能受抗指纹保护影响。</p><p role="status" aria-live="polite"></p><div class="actions"><button class="primary" type="button" data-action="pdf">转为 PDF</button><button type="button" data-action="original">发送原图</button><button type="button" data-action="cancel">取消</button></div></dialog>`;
    const dialog = shadow.querySelector('dialog');
    const state = shadow.querySelector('[role="status"]');
    const pdfButton = shadow.querySelector('[data-action="pdf"]');
    const originalButton = shadow.querySelector('[data-action="original"]');
    let result;
    let closed = false;
    let preparingToken;
    function close() {
      closed = true;
      if (preparingToken) browser.runtime.sendMessage({ type: 'obscura-pdf-cancel-upload', token: preparingToken }).catch(() => {});
      dialog.close(); host.remove(); activeDialog = null;
      if (editor.isConnected) editor.focus();
    }
    shadow.querySelector('[data-action="cancel"]').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    originalButton.onclick = async () => {
      if (!editor.isConnected) { state.textContent = '输入框已变化，请取消后重新粘贴'; return; }
      const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
      editor.setAttribute('data-obscura-paste', token);
      originalButton.disabled = true;
      pdfButton.disabled = true;
      try {
        await currentNotice?.cancel();
        const serialized = await serialize(files);
        if (closed) return;
        replaying = true;
        await browser.runtime.sendMessage({ type: 'obscura-image-original', files: serialized, text, token });
        close();
      } catch (error) {
        state.textContent = error.message || '无法添加原图，请重试';
      } finally {
        replaying = false;
        editor.removeAttribute('data-obscura-paste');
        originalButton.disabled = false;
        pdfButton.disabled = false;
      }
    };
    pdfButton.onclick = async () => {
      pdfButton.disabled = true;
      originalButton.disabled = true;
      state.textContent = '正在本地转换…';
      try {
        await currentNotice?.cancel();
        if (!result) {
          const source = files.filter(file => file.type.startsWith('image/'));
          const images = await serialize(source);
          result = await browser.runtime.sendMessage({ type: 'obscura-image-pdf', files: images });
        }
        if (closed) return;
        if (!editor.isConnected) throw new Error('输入框已变化，请取消后重新粘贴');
        const bytes = Uint8Array.from(atob(result.data), value => value.charCodeAt(0));
        const pdf = new File([bytes], result.name, { type: 'application/pdf' });
        const input = uploadInput(editor);
        if (!input) {
          if (files.some(file => !file.type.startsWith('image/'))) throw new Error('请单独粘贴图片后转换为 PDF');
          const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
          preparingToken = token;
          document.documentElement.setAttribute('data-obscura-pdf-upload', token);
          let saved;
          try {
            saved = await browser.runtime.sendMessage({ type: 'obscura-pdf-prepare-upload', file: result, token });
          } finally { document.documentElement.removeAttribute('data-obscura-pdf-upload'); }
          if (closed || saved.cancelled) return;
          preparingToken = null;
          close();
          uploadNotice(token, saved.name);
          return;
        }
        const transfer = new DataTransfer();
        transfer.items.add(pdf);
        for (const file of files.filter(file => !file.type.startsWith('image/'))) transfer.items.add(file);
        if (transfer.files.length > 1 && !input.multiple) throw new Error('此上传控件只支持单个文件，请单独粘贴图片');
        if (input.files.length) throw new Error('上传控件已有文件，请处理完成后重试');
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        close();
      } catch (error) {
        if (!closed) state.textContent = error.message || '转换失败，请重试或选择原图';
      } finally { pdfButton.disabled = false; originalButton.disabled = false; }
    };
    document.documentElement.append(host);
    dialog.showModal();
    pdfButton.focus();
    activeDialog = dialog;
  }
  window.addEventListener('paste', event => {
    if (replaying || event.defaultPrevented) return;
    const files = [...(event.clipboardData?.files || [])];
    if (!files.some(file => file.type.startsWith('image/'))) return;
    const editor = event.composedPath().find(node => node instanceof Element && (node.isContentEditable || node.matches('textarea,input:not([type]),input[type="text"],input[type="search"]')));
    if (!editor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (activeDialog) { activeDialog.focus(); return; }
    const text = [...event.clipboardData.types].filter(type => type.startsWith('text/')).map(type => [type, event.clipboardData.getData(type)]);
    choose(files, editor, text);
  }, true);
})();
