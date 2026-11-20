const zh = browser.i18n.getUILanguage().startsWith('zh');
const copy = zh ? {
  heading: '下载视频', quality: '清晰度', best: '最佳清晰度（自动合并音画）',
  loading: '正在解析可用清晰度…', ready: '下载后自动合并视频和音轨。',
  download: '下载', cancel: '取消', retry: '重新解析', starting: '正在创建下载任务…',
  started: '下载任务已创建，可在 Firefox 下载列表中查看。', empty: '没有找到可用的视频清晰度。',
  invalid: '视频地址无效，请返回网页重新右键下载。'
} : {
  heading: 'Download video', quality: 'Quality', best: 'Best available quality (merge video and audio)',
  loading: 'Inspecting available qualities…', ready: 'Video and audio will be merged automatically.',
  download: 'Download', cancel: 'Cancel', retry: 'Retry', starting: 'Creating download…',
  started: 'Download started. View progress in Firefox downloads.', empty: 'No video formats were found.',
  invalid: 'Invalid video URL. Return to the page and right-click the video again.'
};
const element = id => document.getElementById(id);
const url = new URLSearchParams(location.search).get('url');
let starting = false;
let started = false;
element('heading').textContent = copy.heading;
element('quality-label').textContent = copy.quality;
element('download').textContent = copy.download;
element('cancel').textContent = copy.cancel;
element('retry').textContent = copy.retry;
document.title = copy.heading + ' · Obscura';

async function inspect() {
  element('retry').hidden = true;
  element('download').disabled = true;
  element('quality').disabled = true;
  element('status').textContent = copy.loading;
  try {
    if (!/^https?:\/\//i.test(url || '')) throw new Error(copy.invalid);
    const details = await browser.runtime.sendMessage({ type: 'media-inspect', url });
    const formats = (details.formats || []).filter(format => !format.audioOnly);
    if (!formats.length) throw new Error(copy.empty);
    element('title').textContent = details.title || url;
    const options = [new Option(copy.best, '')];
    for (const format of formats) {
      const size = format.size ? ` · ${(format.size / 1048576).toFixed(1)} MB` : '';
      options.push(new Option((format.label || format.id) + size, format.id));
    }
    element('quality').replaceChildren(...options);
    element('quality').disabled = false;
    element('download').disabled = false;
    element('status').textContent = copy.ready;
  } catch (error) {
    element('status').textContent = error.message;
    element('retry').hidden = false;
  }
}
element('download-form').onsubmit = async event => {
  event.preventDefault();
  if (starting || started || element('download').disabled) return;
  starting = true;
  element('download').disabled = true;
  element('quality').disabled = true;
  element('cancel').disabled = true;
  element('status').textContent = copy.starting;
  try {
    await browser.runtime.sendMessage({ type: 'native-download', args: { url, media: true, format: element('quality').value || undefined } });
    started = true;
    element('status').textContent = copy.started;
    await browser.obscuraNative.openDownloads();
    const tab = await browser.tabs.getCurrent();
    await browser.tabs.remove(tab.id);
  } catch (error) {
    element('status').textContent = started ? copy.started + ' ' + error.message : error.message;
    element('download').disabled = started;
    element('quality').disabled = started;
  } finally { starting = false; element('cancel').disabled = false; }
};
element('retry').onclick = inspect;
element('cancel').onclick = async () => {
  const tab = await browser.tabs.getCurrent();
  await browser.tabs.remove(tab.id);
};
inspect();
