const pendingAttachments = [];
const attachmentPreviews = new Map();
const fileLimit = 16 * 1024 * 1024;
const messageLimit = 32 * 1024 * 1024;

function attachmentCard(attachment, remove) {
  const card = document.createElement('div'); card.className = 'attachment-card';
  const preview = document.createElement('div'); preview.className = 'attachment-preview';
  if (attachment.kind === 'image') {
    const image = document.createElement('img'); image.alt = attachment.name;
    const known = attachment.preview || attachmentPreviews.get(attachment.id);
    if (known) image.src = known;
    else if (attachment.id) request('/attachments/' + attachment.id).then(value => {
      const url = `data:${value.mime};base64,${value.data}`;
      attachmentPreviews.set(attachment.id, url); image.src = url;
    }).catch(() => { image.alt = '预览不可用'; });
    preview.append(image);
  } else {
    const icon = document.createElement('span'); icon.className = 'attachment-file-type';
    icon.textContent = attachment.kind === 'pdf' ? 'PDF' : 'TXT'; preview.append(icon);
  }
  const name = document.createElement('span'); name.className = 'attachment-name'; name.textContent = attachment.name; name.title = attachment.name;
  card.append(preview, name);
  if (remove) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'attachment-remove';
    button.textContent = '×'; button.setAttribute('aria-label', '删除附件 ' + attachment.name);
    button.onclick = remove; card.append(button);
  }
  return card;
}

function renderPendingAttachments() {
  const container = $('pending-attachments');
  container.hidden = !pendingAttachments.length;
  container.replaceChildren(...pendingAttachments.map(attachment => attachmentCard(attachment, () => {
    const index = pendingAttachments.indexOf(attachment);
    if (index >= 0) pendingAttachments.splice(index, 1);
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    renderPendingAttachments();
  })));
  $('attach-count').textContent = pendingAttachments.length ? `${pendingAttachments.length}/10` : '';
}

async function addAttachments(files) {
  const added = [];
  let failure = '';
  for (const file of files) {
    if (pendingAttachments.length >= 10) { failure = '每条消息最多添加 10 个附件'; break; }
    const total = pendingAttachments.reduce((sum, attachment) => sum + attachment.file.size, 0);
    if (!file.size || file.size > fileLimit || total + file.size > messageLimit) { failure = '单文件最多 16 MB，每条消息的附件总量最多 32 MB'; continue; }
    const image = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
    const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const text = file.type.startsWith('text/') || /\.(txt|md|csv|json|jsonl|xml|html?|css|js|ts|py|rs|yaml|yml|log|svg)$/i.test(file.name);
    if (!image && !pdf && !text) { failure = '支持 PNG、JPEG、WebP、文本文件和 PDF'; continue; }
    const attachment = { file, name: file.name || '粘贴的图片.png', mime: file.type, kind: image ? 'image' : pdf ? 'pdf' : 'text', preview: image ? URL.createObjectURL(file) : null };
    pendingAttachments.push(attachment); added.push(attachment);
  }
  renderPendingAttachments();
  if (failure) status(failure, true);
  return added;
}

async function uploadAttachments(batch) {
  const references = [];
  for (const attachment of batch) {
    if (!attachment.id) {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('无法读取附件'));
        reader.readAsDataURL(attachment.file);
      });
      const metadata = await request('/attachments', { name: attachment.name, mime: attachment.mime, data });
      Object.assign(attachment, metadata);
    }
    if (attachment.preview) attachmentPreviews.set(attachment.id, attachment.preview);
    references.push({ id: attachment.id, name: attachment.name, kind: attachment.kind, mime: attachment.mime, size: attachment.size });
  }
  return references;
}

function consumeAttachments(batch) {
  for (const attachment of batch) {
    const index = pendingAttachments.indexOf(attachment);
    if (index >= 0) pendingAttachments.splice(index, 1);
  }
  renderPendingAttachments();
}

function appendMessageAttachments(element, attachments) {
  if (!attachments?.length) return;
  const container = document.createElement('div'); container.className = 'message-attachments';
  container.append(...attachments.map(attachment => attachmentCard(attachment)));
  element.append(container);
}

function resetAttachmentCache() {
  const pendingURLs = new Set(pendingAttachments.map(attachment => attachment.preview));
  for (const url of attachmentPreviews.values()) if (url.startsWith('blob:') && !pendingURLs.has(url)) URL.revokeObjectURL(url);
  attachmentPreviews.clear();
  for (const attachment of pendingAttachments) delete attachment.id;
}

$('attach-files').onclick = () => $('attachment-input').click();
$('attachment-input').onchange = async event => { await addAttachments(event.target.files); event.target.value = ''; };
$('chat-form').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  event.preventDefault(); addAttachments(files);
});
$('chat-form').addEventListener('dragover', event => {
  if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); $('chat-form').classList.add('dragging'); }
});
$('chat-form').addEventListener('dragleave', () => $('chat-form').classList.remove('dragging'));
$('chat-form').addEventListener('drop', event => {
  $('chat-form').classList.remove('dragging');
  if (!event.dataTransfer.files.length) return;
  event.preventDefault(); addAttachments(event.dataTransfer.files);
});
