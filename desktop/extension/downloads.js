let detectedMedia = [];
let mediaRefreshGeneration = 0;
let renderedMediaSnapshot;
const selectedMedia = new Set();
const formatSelections = new Map();
const availableFormats = new Map();
const bytes = value => value == null ? '大小未知' : value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
const downloadRequest = (action, args = {}) => workspace.nativeDownloads && action === 'add' ? workspace.download(args.args) : request('/downloads', { action, ...args });

function makeButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = label;
  button.onclick = () => run(action);
  return button;
}

async function refreshDownloads() {
  const result = await downloadRequest('list');
  if (result.folder) $('download-folder').textContent = '保存位置 ' + result.folder;
  const names = { Downloading: '下载中', Complete: '已完成', Stopped: '已暂停', Queued: '排队中', Error: '失败' };
  const cards = result.downloads.map(job => {
    const card = document.createElement('article'); card.className = 'download-card'; card.dataset.id = job.id;
    const title = document.createElement('strong'); title.textContent = job.file;
    const info = document.createElement('p'); info.className = 'muted';
    info.textContent = `${names[job.status] || job.status} · ${bytes(job.downloaded)} / ${bytes(job.size)} · ${bytes(job.speed || 0)}/s`;
    if (job.fragments) info.textContent += ` · 分段 ${job.fragment || 0}/${job.fragments}`;
    const progress = document.createElement('progress');
    if (job.size) { progress.max = job.size; progress.value = job.downloaded || 0; }
    if (job.status === 'Complete') { progress.max = 1; progress.value = 1; }
    const controls = document.createElement('div'); controls.className = 'row';
    if (job.status === 'Downloading') controls.append(makeButton('暂停', async () => { await downloadRequest('pause', { ids: [job.id] }); await refreshDownloads(); }));
    if (['Stopped', 'Error', 'Queued'].includes(job.status)) controls.append(makeButton(job.status === 'Error' ? '重试' : '继续', async () => { await downloadRequest('resume', { ids: [job.id] }); await refreshDownloads(); }));
    if (job.status !== 'Downloading') controls.append(makeButton('移除记录', async () => { await downloadRequest('remove', { ids: [job.id] }); await refreshDownloads(); }));
    card.append(title, info, progress, controls);
    if (job.path) { const location = document.createElement('p'); location.className = 'muted'; location.textContent = job.path; card.append(location); }
    if (job.error) { const error = document.createElement('p'); error.className = 'error'; error.textContent = job.error; card.append(error); }
    return card;
  });
  $('downloads-list').replaceChildren(...cards);
  if (!cards.length) $('downloads-list').textContent = '暂无下载任务';
}

async function refreshMedia() {
  const generation = ++mediaRefreshGeneration;
  await target();
  const tabId = activeTab.id;
  const result = await workspace.message({ type: 'media-list', tabId });
  if (generation !== mediaRefreshGeneration) return;
  detectedMedia = result.media || [];
  const snapshot = JSON.stringify([tabId, result.cleared, detectedMedia.map(({ detectedAt, ...media }) => media)]);
  if (snapshot === renderedMediaSnapshot) return;
  renderedMediaSnapshot = snapshot;
  const valid = new Set(detectedMedia.map(item => item.url));
  for (const url of selectedMedia) if (!valid.has(url)) selectedMedia.delete(url);
  const cards = detectedMedia.map(media => {
    const card = document.createElement('article'); card.className = 'download-card media-card';
    const label = document.createElement('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedMedia.has(media.url);
    checkbox.onchange = () => { if (checkbox.checked) selectedMedia.add(media.url); else selectedMedia.delete(media.url); };
    const title = document.createElement('span'); title.textContent = media.title;
    label.append(checkbox, title);
    const info = document.createElement('p'); info.className = 'muted'; info.textContent = `${media.kind} · ${media.host} · ${bytes(media.size)}`;
    const url = document.createElement('p'); url.className = 'media-url'; url.textContent = media.url;
    const quality = document.createElement('select'); quality.setAttribute('aria-label', '媒体清晰度');
    const best = document.createElement('option'); best.value = ''; best.textContent = '自动选择最佳清晰度'; quality.append(best);
    function setFormats(formats) {
      quality.replaceChildren(best);
      for (const format of formats) {
        const option = document.createElement('option'); option.value = format.id;
        option.textContent = `${format.label || format.id} · ${bytes(format.size)}`; quality.append(option);
      }
      quality.value = formatSelections.get(media.url) || '';
    }
    setFormats(availableFormats.get(media.url) || []);
    quality.onchange = () => formatSelections.set(media.url, quality.value);
    const actions = document.createElement('div'); actions.className = 'row';
    actions.append(makeButton('解析清晰度', async () => {
      const details = await downloadRequest('inspect', { url: media.downloadUrl || media.url });
      availableFormats.set(media.url, details.formats);
      setFormats(details.formats);
      if (!details.formats.length) throw new Error('未找到可用媒体清晰度');
    }));
    actions.append(makeButton('下载此媒体', async () => { await addDetected(media); await refreshDownloads(); }));
    card.append(label, info, url, quality, actions); return card;
  });
  $('media-list').replaceChildren(...cards);
  if (!cards.length) $('media-list').textContent = result.cleared ? '列表已清空。点击“重新嗅探”继续检测媒体。' : '尚未嗅探到媒体。请先在网页播放视频或音频。';
}

async function addDetected(media) {
  await downloadRequest('add', { args: { url: media.downloadUrl || media.url, media: true, format: formatSelections.get(media.url) || media.format || undefined } });
}

$('download-form').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    await downloadRequest('add', { args: { url: $('download-url').value.trim(), media: $('download-type').value === 'media' } });
    $('download-url').value = ''; await refreshDownloads();
  });
};
$('media-refresh').onclick = () => run(async () => {
  await target();
  await workspace.message({ type: 'media-rescan', tabId: activeTab.id });
  renderedMediaSnapshot = undefined;
  await refreshMedia();
});
$('media-clear').onclick = () => run(async () => {
  mediaRefreshGeneration++;
  await target();
  await workspace.message({ type: 'media-clear', tabId: activeTab.id });
  selectedMedia.clear();
  formatSelections.clear();
  availableFormats.clear();
  renderedMediaSnapshot = undefined;
  await refreshMedia();
});
$('downloads-refresh').onclick = () => run(refreshDownloads);
$('downloads-clear').onclick = async () => {
  const button = $('downloads-clear');
  button.disabled = true;
  try {
    const { downloads } = await downloadRequest('list');
    const ids = downloads.filter(job => ['Complete', 'Error', 'Stopped'].includes(job.status)).map(job => job.id);
    if (ids.length) await downloadRequest('remove', { ids });
    await refreshDownloads();
    status(ids.length ? '已清除任务记录，下载文件已保留' : '没有可清除的任务记录');
  } catch (error) { status(error.message, true); }
  finally { button.disabled = false; }
};

$('media-download-selected').onclick = () => run(async () => {
  const selected = detectedMedia.filter(media => selectedMedia.has(media.url));
  if (!selected.length) throw new Error('请先勾选要下载的媒体');
  for (const media of selected) { await addDetected(media); selectedMedia.delete(media.url); }
  await refreshDownloads(); await refreshMedia();
});
document.querySelector('[data-tab="downloads"]').addEventListener('click', () => run(async () => { await refreshDownloads(); await refreshMedia(); }));
setInterval(() => {
  if (!$('downloads').hidden) {
    refreshDownloads().catch(error => status(error.message, true));
    refreshMedia().catch(error => status(error.message, true));
  }
}, 1500);
