var { ExtensionCommon } = ChromeUtils.importESModule('resource://gre/modules/ExtensionCommon.sys.mjs');
var { ExtensionError } = ChromeUtils.importESModule('resource://gre/modules/ExtensionUtils.sys.mjs');
var mediaDownloads = new Map();
Cu.importGlobalProperties(['fetch', 'URL']);
this.obscuraNative = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const pinPref = 'obscura.workspace.toolbarPinned';
    if (!Services.prefs.getBoolPref(pinPref, false)) {
      const { CustomizableUI } = ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs');
      const widgetId = context.extension.id.toLowerCase().replace(/[^a-z0-9_-]/g, '_') + '-browser-action';
      CustomizableUI.addWidgetToArea(widgetId, CustomizableUI.AREA_NAVBAR);
      Services.prefs.setBoolPref(pinPref, true);
    }
    return { obscuraNative: {
      async trackMediaDownload(payload) {
        try {
        const { job, folder, bridge } = JSON.parse(payload);
        if (!/^media-[a-z0-9-]+$/.test(job.id) || !/^https?:/.test(job.url) || !folder.startsWith('/')) throw new ExtensionError('Invalid media task');
        const origin = new URL(bridge.origin);
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new ExtensionError('Invalid local bridge');
        if (mediaDownloads.has(job.id)) return;
        const { Downloads } = ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs');
        const { DownloadSaver } = ChromeUtils.importESModule('resource://gre/modules/DownloadCore.sys.mjs');
        const { setTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
        async function request(action) {
          const response = await fetch(origin.origin + '/downloads', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Obscura-Token': bridge.token }, body: JSON.stringify({ action, ids: [job.id] }) });
          if (!response.ok) throw new Error('Media download service unavailable');
          return response.json();
        }
        const download = await Downloads.createDownload({ source: { url: job.url }, target: job.path || folder + '/' + job.id + '/media.mp4' });
        const saver = Object.create(DownloadSaver.prototype);
        Object.assign(saver, {
          download, canceled: false, first: true,
          async execute(progress) {
            this.canceled = false;
            if (!this.first) await request('resume');
            this.first = false;
            while (!this.canceled) {
              const result = await request('list');
              const current = result.downloads.find(item => item.id === job.id);
              if (!current) throw new Error('Media task removed');
              progress(current.downloaded || 0, current.size || -1, true);
              if (current.status === 'Complete') {
                if (!current.path?.startsWith(folder + '/')) throw new Error('Invalid media output path');
                download.target.path = current.path;
                return;
              }
              if (current.status === 'Error') throw new Error(current.error || 'Media download failed');
              if (current.status === 'Stopped') { download.cancel().catch(console.error); throw new Error('Paused'); }
              await new Promise(resolve => setTimeout(resolve, 750));
            }
            throw new Error('Paused');
          },
          cancel() { this.canceled = true; return request('pause'); },
          async removeData() {},
          toSerializable() { return null; },
          getSha256Hash() { return null; },
          getSignatureInfo() { return null; }
        });
        download.saver = saver; download.tryToKeepPartialData = true;
        mediaDownloads.set(job.id, download);
        await (await Downloads.getList(Downloads.PUBLIC)).add(download);
        download.start().catch(console.error);
        } catch (error) { throw new ExtensionError(error.message); }
      },
      async setPrivacyCompatibility(enabled) {
        Services.prefs.setCharPref('privacy.resistFingerprinting.exemptedDomains', enabled ? 'x.com,*.x.com' : '');
        Services.prefs.setBoolPref('media.peerconnection.enabled', false);
      },
      async stop(tabId) {
        const tab = context.extension.tabManager.get(tabId);
        tab.nativeTab.linkedBrowser.stop();
        return 'Stopped';
      },
      async setSearchEngine(key) {
        const providers = { google: ['Google', 'https://www.google.com/search?q={searchTerms}'], bing: ['Bing', 'https://www.bing.com/search?q={searchTerms}'], duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q={searchTerms}'], baidu: ['百度', 'https://www.baidu.com/s?wd={searchTerms}'], yahoo: ['Yahoo', 'https://search.yahoo.com/search?p={searchTerms}'], brave: ['Brave Search', 'https://search.brave.com/search?q={searchTerms}'] };
        const provider = providers[key];
        if (!provider) throw new Error('Unsupported search engine');
        const { SearchService } = ChromeUtils.importESModule('moz-src:///toolkit/components/search/SearchService.sys.mjs');
        await SearchService.init();
        let engine = SearchService.getEngineByName(provider[0]);
        if (!engine) { await SearchService.addUserEngine({ name: provider[0], url: provider[1], alias: '' }); engine = SearchService.getEngineByName(provider[0]); }
        await SearchService.setDefault(engine, SearchService.CHANGE_REASON.USER);
        return provider[0];
      },
      async pressKey(tabId, key) {
        try {
        const tab = context.extension.tabManager.get(tabId);
        const native = tab.nativeTab;
        if (!['http', 'https'].includes(native.linkedBrowser.currentURI.scheme)) throw new Error('Only HTTP/HTTPS tabs support native input');
        const window = native.documentGlobal;
        const parts = key.split('+');
        const name = parts.pop();
        const modifiers = { Shift: 0x100, Control: 0x400, Ctrl: 0x400, Alt: 0x1000, Option: 0x1000, Meta: 0x4000, Cmd: 0x4000, Command: 0x4000, ControlOrMeta: 0x4000 };
        let flags = 0;
        for (const part of parts) {
          if (!(part in modifiers)) throw new Error('Unsupported key modifier');
          flags |= modifiers[part];
        }
        const codes = { Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
          a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38, k: 40, l: 37, m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
          '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26, '8': 28, '9': 25 };
        const normalized = name.length === 1 ? name.toLowerCase() : name;
        if (!(normalized in codes)) throw new Error('Unsupported keyboard key');
        const characters = { Enter: '\r', Tab: '\t', Space: ' ', Backspace: '\x7f', Escape: '\x1b', Delete: '\uf728', Home: '\uf729', End: '\uf72b', PageUp: '\uf72c', PageDown: '\uf72d', ArrowUp: '\uf700', ArrowDown: '\uf701', ArrowLeft: '\uf702', ArrowRight: '\uf703' };
        const text = name.length === 1 ? (flags & 0x100 ? name.toUpperCase() : name) : characters[name] || '';
        window.gBrowser.selectedTab = native;
        Cc['@mozilla.org/widget/macdocksupport;1'].getService(Ci.nsIMacDockSupport).activateApplication(true);
        window.focus(); native.linkedBrowser.focus();
        const focusDeadline = Date.now() + 2000;
        while (!window.document.hasFocus() && Date.now() < focusDeadline) await new Promise(resolve => window.setTimeout(resolve, 20));
        if (!window.document.hasFocus()) throw new Error('Browser window could not acquire keyboard focus');
        await new Promise((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('Native key dispatch timed out')), 5000);
          try { window.windowUtils.sendNativeKeyEvent(0, codes[normalized], flags, text, text, () => { window.clearTimeout(timer); resolve(); }); }
          catch (error) { window.clearTimeout(timer); reject(error); }
        });
        return 'Key pressed';
        } catch (error) {
          console.error('Obscura native key dispatch:', error);
          throw new ExtensionError(error.message);
        }
      }
    } };
  }
};
