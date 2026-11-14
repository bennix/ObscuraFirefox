const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const { resolvePacRoute } = require('./proxy.cjs');

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const toolDefinitions = [
  ['downloads_list', 'List built-in download tasks and progress. Use this to verify completion.', {}, []],
  ['downloads_add', 'Download an HTTP(S) file or HLS playlist chosen by the user.', { url: { type: 'string' }, media: { type: 'boolean' }, format: { type: 'string' }, file_name: { type: 'string' } }, ['url']],
  ['downloads_pause', 'Pause download tasks by their IDs.', { ids: { type: 'array', items: { type: 'string' } } }, ['ids']],
  ['downloads_resume', 'Resume paused download tasks by their IDs.', { ids: { type: 'array', items: { type: 'string' } } }, ['ids']],
  ['downloads_remove', 'Remove stopped tasks from the list, keeping downloaded files.', { ids: { type: 'array', items: { type: 'string' } } }, ['ids']]
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } }));

function mediaFormats(formats) {
  return formats.filter(f => (f.url || f.manifest_url || f.fragments?.length) && !f.has_drm && !(f.vcodec === 'none' && f.acodec === 'none') && f.ext !== 'mhtml')
    .sort((a,b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0))
    .map(f => {
      const videoOnly = f.vcodec && f.vcodec !== 'none' && f.acodec === 'none';
      const audioOnly = f.vcodec === 'none';
      const id = videoOnly ? `${f.format_id}+bestaudio/${f.format_id}` : f.format_id;
      const size = f.filesize || f.filesize_approx || null;
      return { id, formatId: f.format_id, label: [audioOnly ? 'Audio' : f.height ? `${f.height}p` : f.resolution, f.fps ? `${f.fps}fps` : '', f.dynamic_range && f.dynamic_range !== 'SDR' ? f.dynamic_range : '', f.ext, f.vcodec && f.vcodec !== 'none' ? f.vcodec.split('.')[0] : f.acodec, f.language, f.format_note, videoOnly ? '+ audio' : ''].filter(Boolean).join(' · '), size: videoOnly ? null : size, videoSize: videoOnly ? size : undefined, height: f.height, fps: f.fps, videoOnly, audioOnly };
    });
}

class Downloads {
  constructor({ directory, browserTools, transport, output }) {
    this.directory = path.join(directory, 'downloads');
    this.data = path.join(this.directory, 'mdm');
    this.output = output || path.join(os.homedir(), 'Downloads/Obscura');
    this.browserTools = browserTools;
    this.transport = transport;
    this.binary = path.join(__dirname, 'runtime/mdm/Mister Download Manager.app/Contents/MacOS/misterdownloadmanager');
    this.mediaRoot = path.join(__dirname, 'runtime/media');
    this.jobs = [];
    this.children = new Map();
    this.writes = Promise.resolve();
  }

  async ready() {
    if (!this.initializing) this.initializing = this.initialize().catch(error => { this.initializing = null; throw error; });
    return this.initializing;
  }

  async initialize() {
    await fs.mkdir(this.data, { recursive: true });
    await fs.chmod(this.directory, 0o700);
    await fs.mkdir(this.output, { recursive: true });
    try { this.jobs = JSON.parse(await fs.readFile(path.join(this.directory, 'media.json'), 'utf8')); } catch {}
    for (const job of this.jobs) if (job.status === 'Downloading') { job.status = 'Stopped'; job.speed = 0; }
    try { await this.ipc({ api: true }); return; } catch {}
    this.process = spawn(this.binary, ['--headless', '--data', this.data, '--downloads', this.output], {
      env: { ...process.env, MDM_REMOTE: 'off', MDM_DATA_DIR: this.data }, stdio: ['ignore', 'ignore', 'pipe']
    });
    let launchError, log = '';
    this.process.on('error', error => { launchError = error; });
    this.process.stderr.on('data', chunk => { log = (log + chunk).slice(-3000); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError;
      if (this.process.exitCode !== null) throw new Error('内置 MDM 启动失败。' + log);
      try { await this.ipc({ api: true }); return; } catch {}
      await delay(100);
    }
    throw new Error('内置下载引擎启动超时');
  }

  async ipc(command) {
    const endpoint = JSON.parse(await fs.readFile(path.join(this.data, 'ipc.json'), 'utf8'));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: endpoint.port });
      let buffer = '';
      socket.setTimeout(10000, () => socket.destroy(new Error('下载引擎响应超时')));
      socket.on('error', reject);
      socket.on('end', () => { if (!buffer.includes('\n')) reject(new Error('下载引擎连接已关闭')); });
      socket.on('connect', () => socket.write(JSON.stringify({ ...command, token: endpoint.token }) + '\n'));
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 16000000) { socket.destroy(new Error('下载列表过大')); return; }
        if (!buffer.includes('\n')) return;
        socket.end();
        const line = buffer.slice(0, buffer.indexOf('\n'));
        if (line === 'ok') { resolve({ ok: true }); return; }
        try {
          const result = JSON.parse(line);
          if (result.error) reject(new Error(result.error)); else resolve(result);
        } catch { reject(new Error('下载引擎返回无效响应')); }
      });
    });
  }

  save() {
    const content = JSON.stringify(this.jobs, null, 2);
    const file = path.join(this.directory, 'media.json');
    this.writes = this.writes.then(async () => {
      await fs.writeFile(file + '.tmp', content, { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
    }).catch(() => {});
    return this.writes;
  }

  async context(url) {
    const proxy = await this.transport.resolve(url);
    const context = { proxy: proxy || undefined };
    if (proxy.startsWith('pac+')) {
      const response = await fetch(proxy.slice(4), { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('无法读取系统代理脚本');
      context.proxy_pac = await response.text(); delete context.proxy;
    }
    const browser = this.browserTools.browser?.contexts()[0];
    if (browser || this.browserTools.cookies) {
      const cookies = this.browserTools.cookies ? await this.browserTools.cookies(url) : await browser.cookies(url);
      context.cookies = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      context.cookie_jar = cookies;
      try {
        const page = await this.browserTools.page();
        context.referer = page.url();
        context.user_agent = await page.evaluate(() => navigator.userAgent);
      } catch {}
    }
    return context;
  }

  async list() {
    await this.ready();
    const result = await this.ipc({ query: 'list' });
    return { ...result, folder: this.output, downloads: [...this.jobs, ...result.downloads.map(job => ({ ...job, id: `mdm-${job.id}`, kind: 'file' }))] };
  }

  async add(args) {
    await this.ready();
    const url = new URL(args.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请选择 HTTP 或 HTTPS 下载地址');
    if (args.media || /\.(m3u8|mpd)(?:$|\?)/i.test(url.href)) return this.addMedia(args);
    const name = args.file_name ? path.basename(args.file_name) : undefined;
    const before = await this.ipc({ query: 'list' });
    await this.ipc({ url: url.href, name, dir: this.output, silent: true, ...(await this.context(url.href)) });
    for (let attempt = 0; attempt < 40; attempt++) {
      const after = await this.ipc({ query: 'list' });
      const added = after.downloads.find(job => job.url === url.href && !before.downloads.some(previous => previous.id === job.id));
      if (added) return { ...added, id: `mdm-${added.id}` };
      await delay(100);
    }
    throw new Error('下载引擎未接受任务，链接可能已存在');
  }

  async mediaArguments(url, folder) {
    const context = await this.context(url);
    const args = ['--no-playlist', '--js-runtimes', 'node:' + process.execPath, '--output-na-placeholder', 'null', '--ffmpeg-location', path.join(this.mediaRoot, 'ffmpeg')];
    if (context.user_agent) args.push('--user-agent', context.user_agent);
    if (context.referer) args.push('--referer', context.referer);
    if (context.cookie_jar?.length) {
      const cookieFile = path.join(folder, 'cookies.txt');
      const lines = context.cookie_jar.map(cookie => [cookie.domain, cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE', cookie.path, cookie.secure ? 'TRUE' : 'FALSE', Math.max(0, Math.floor(cookie.expires || 0)), cookie.name, cookie.value].join('\t'));
      await fs.writeFile(cookieFile, '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n', { mode: 0o600 });
      args.push('--cookies', cookieFile);
    }
    if (context.proxy_pac) context.proxy = await resolvePacRoute(context.proxy_pac, url);
    const env = { ...process.env };
    if (context.proxy) {
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = context.proxy;
      env.NO_PROXY = ''; env.no_proxy = '';
    }
    return { args, env };
  }

  async inspect(url) {
    await this.ready();
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('请选择 HTTP 或 HTTPS 媒体地址');
    const folder = await fs.mkdtemp(path.join(this.directory, 'inspect-'));
    try {
      const { args, env } = await this.mediaArguments(url, folder);
      const { stdout } = await execute(path.join(this.mediaRoot, 'yt-dlp/yt-dlp_macos'), [...args, '--dump-single-json', '--skip-download', '--', url], { env, timeout: 60000, maxBuffer: 8000000 });
      const info = JSON.parse(stdout);
      return { title: info.title, formats: mediaFormats(info.formats || []) };
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  }

  async addMedia(args) {
    const job = { id: 'media-' + randomUUID(), url: args.url, file: args.file_name || 'HLS / 媒体下载', file_name: args.file_name ? path.basename(args.file_name) : undefined, format: args.format || 'bestvideo*+bestaudio/best', kind: 'media', status: 'Stopped', downloaded: 0, size: null, speed: 0, added: new Date().toISOString() };
    this.jobs.unshift(job);
    try { await this.runMedia(job); }
    catch (error) { job.status = 'Error'; job.error = error.message; await this.save(); throw error; }
    return job;
  }

  async runMedia(job) {
    const folder = path.join(this.output, job.id);
    await fs.mkdir(folder, { recursive: true });
    const contextFolder = path.join(this.directory, 'context', job.id);
    await fs.mkdir(contextFolder, { recursive: true, mode: 0o700 });
    const { args, env } = await this.mediaArguments(job.url, contextFolder);
    args.push('--continue', '--part', '--concurrent-fragments', '8', '--retries', '10', '--fragment-retries', '10', '--no-skip-unavailable-fragments',
      '--newline', '--progress', '--progress-template', 'download:{"event":"progress","downloaded":%(progress.downloaded_bytes)j,"size":%(progress.total_bytes)j,"estimate":%(progress.total_bytes_estimate)j,"speed":%(progress.speed)j,"fragment":%(progress.fragment_index)j,"fragments":%(progress.fragment_count)j}',
      '--print', 'after_move:{"event":"done","path":%(filepath)j}', '-f', job.format,
      '-o', path.join(folder, job.file_name ? path.parse(job.file_name).name.replaceAll('%', '%%') + '.%(ext)s' : '%(title).180B.%(ext)s'), '--', job.url);
    const child = spawn(path.join(this.mediaRoot, 'yt-dlp/yt-dlp_macos'), args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set(job.id, child); job.status = 'Downloading'; job.error = undefined;
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-3000); });
    child.on('error', error => { job.status = 'Error'; job.error = error.message; this.save(); });
    const receive = line => {
      let event;
      try { event = JSON.parse(line.slice(line.indexOf('{'))); } catch { return; }
      if (event.event === 'progress') Object.assign(job, {
        downloaded: Math.max(job.downloaded, Number(event.downloaded) || 0),
        size: Math.max(job.size || 0, Number(event.size) || Number(event.estimate) || 0) || null,
        speed: Number(event.speed) || 0,
        fragment: Number(event.fragment) || null,
        fragments: Number(event.fragments) || null
      });
      if (event.event === 'done') {
        Object.assign(job, { status: 'Complete', path: event.path, file: path.basename(event.path), speed: 0 });
        fs.stat(event.path).then(stat => { job.downloaded = job.size = stat.size; this.save(); }).catch(() => {});
      }
      this.save();
    };
    createInterface({ input: child.stdout }).on('line', receive);
    createInterface({ input: child.stderr }).on('line', receive);
    child.on('close', () => {
      this.children.delete(job.id); job.speed = 0;
      if (job.status === 'Downloading') { job.status = 'Error'; job.error = errorText.replace(/https?:\/\/\S+@/g, '[proxy]'); }
      this.save();
      if (job.status === 'Complete') fs.rm(contextFolder, { recursive: true, force: true }).catch(() => {});
    });
    await this.save();
  }

  async act(action, ids) {
    await this.ready();
    const native = ids.filter(id => /^mdm-\d+$/.test(id)).map(id => Number(id.slice(4)));
    if (native.length) await this.ipc({ action, ids: native });
    for (const id of ids.filter(id => id.startsWith('media-'))) {
      const job = this.jobs.find(item => item.id === id);
      if (!job) throw new Error('找不到下载任务');
      const child = this.children.get(id);
      if (action === 'pause' && child && job.status === 'Downloading') { process.kill(-child.pid, 'SIGSTOP'); job.status = 'Stopped'; job.speed = 0; }
      if (action === 'start' && job.status !== 'Complete') {
        if (child && job.status === 'Stopped') { process.kill(-child.pid, 'SIGCONT'); job.status = 'Downloading'; }
        else if (!child) await this.runMedia(job);
      }
      if (action === 'remove') {
        if (child && job.status !== 'Complete' && child.exitCode === null) { process.kill(-child.pid, 'SIGCONT'); process.kill(-child.pid, 'SIGTERM'); }
        this.jobs = this.jobs.filter(item => item.id !== id);
      }
    }
    await this.save(); return this.list();
  }

  async call(name, args = {}) {
    let result;
    if (name === 'downloads_list') result = await this.list();
    else if (name === 'downloads_add') result = await this.add(args);
    else {
      const actions = { downloads_pause: 'pause', downloads_resume: 'start', downloads_remove: 'remove' };
      if (!actions[name] || !Array.isArray(args.ids)) throw new Error('无效的下载操作');
      result = await this.act(actions[name], args.ids);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  async close() {
    if (!this.initializing) return;
    if (this.closing) return this.closing;
    this.closing = this.stop();
    return this.closing;
  }

  async stop() {
    await this.initializing.catch(() => {});
    const pending = [];
    for (const [id, child] of this.children) {
      const job = this.jobs.find(item => item.id === id);
      if (job && job.status !== 'Complete') {
        job.status = 'Stopped'; job.speed = 0;
        try { process.kill(-child.pid, 'SIGCONT'); process.kill(-child.pid, 'SIGTERM'); } catch {}
      }
      pending.push(new Promise(resolve => { child.once('close', resolve); setTimeout(resolve, 3000).unref(); }));
    }
    await Promise.all(pending);
    await this.save();
    try { await this.ipc({ exit: true }); } catch {}
    if (this.process && this.process.exitCode === null) await new Promise(resolve => { this.process.once('close', resolve); setTimeout(resolve, 3000).unref(); });
  }
}

module.exports = { Downloads, toolDefinitions };

module.exports.mediaFormats = mediaFormats;
