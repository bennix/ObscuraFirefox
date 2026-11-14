const { chromium } = require('playwright-core');
const { setTimeout: wait } = require('node:timers/promises');
const definitions = [
  ['browser_navigate', 'Navigate the active browser tab to an HTTP(S) URL.', { url: { type: 'string' } }, ['url']],
  ['browser_snapshot', 'Read active page title, URL, body text and interactive element references. Call before clicking.', {}, []],
  ['browser_click', 'Click an element using a snapshot ref or CSS selector.', { ref: { type: 'string' }, selector: { type: 'string' } }, []],
  ['browser_fill', 'Fill a form field using a snapshot ref or CSS selector.', { ref: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, ['value']],
  ['browser_press_key', 'Press a keyboard key, e.g. Enter, Escape, ArrowDown.', { key: { type: 'string' } }, ['key']],
  ['browser_evaluate', 'Evaluate JavaScript in the active webpage.', { expression: { type: 'string' } }, ['expression']],
  ['browser_screenshot', 'Capture the visible browser viewport.', {}, []],
  ['browser_scroll', 'Scroll the active page by CSS pixels.', { y: { type: 'number' } }, ['y']]
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } }));
class ChromeTools {
  constructor() {
    this.browser = null;
    this.activeTabId = null;
    this.activeURL = null;
    this.currentPage = null;
    this.navigationLatency = 15000;
    this.onNetwork = () => {};
  }
  async navigate(page, url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.signal?.throwIfAborted();
      const started = Date.now();
      const timeout = Math.min(120000, Math.max(30000, this.navigationLatency * 4));
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        if ([429, 502, 503, 504].includes(response?.status())) throw new Error(`网页暂时不可用（HTTP ${response.status()}）`);
        this.navigationLatency = this.navigationLatency * .7 + (Date.now() - started) * .3;
        this.onNetwork({ type: 'network', source: 'browser', status: 'connected' });
        return { url: page.url(), title: await page.title() };
      } catch (error) {
        this.signal?.throwIfAborted();
        if (attempt === 2 || /ERR_CERT|ERR_INVALID|ERR_BLOCKED|Target closed|has been closed/.test(error.message)) throw error;
        const delayMs = 1000 * 2 ** attempt;
        this.onNetwork({ type: 'network', source: 'browser', status: 'retrying', attempt: attempt + 1, delayMs });
        await wait(delayMs, undefined, { signal: this.signal });
      }
    }
  }
  async connect(endpoint) { this.browser = await chromium.connectOverCDP(endpoint); }
  async stop() {
    const pages = this.currentPage ? [this.currentPage] : this.browser.contexts()[0].pages().filter(page => /^https?:/.test(page.url()));
    await Promise.allSettled(pages.map(async page => {
      const session = await page.context().newCDPSession(page);
      try { await Promise.allSettled([session.send('Runtime.terminateExecution'), session.send('Page.stopLoading')]); }
      finally { await session.detach(); }
    }));
  }
  async page() {
    const pages = this.browser.contexts()[0].pages().filter(page => /^https?:/.test(page.url()));
    if (!pages.length) throw new Error('请先打开一个 HTTP/HTTPS 网页标签');
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    if (this.activeURL) {
      const match = pages.find(page => page.url() === this.activeURL);
      if (match) return match;
    }
    if (this.activeTabId) {
      for (const page of pages) {
        const cdp = await page.context().newCDPSession(page);
        try {
          const { targetInfo } = await cdp.send('Target.getTargetInfo');
          if (targetInfo.targetId === this.activeTabId) return page;
        } finally { await cdp.detach(); }
      }
    }
    return pages.at(-1);
  }
  async call(name, args = {}) {
    this.signal?.throwIfAborted();
    if (!definitions.some(tool => tool.name === name)) throw new Error('Unknown browser tool');
    const page = await this.page();
    const target = () => {
      if (args.ref && /^e\d+$/.test(args.ref)) return page.locator(`[data-obscura-ref="${args.ref}"]`).first();
      if (args.selector) return page.locator(args.selector).first();
      throw new Error('请提供 ref 或 CSS selector');
    };
    let value;
    switch (name) {
      case 'browser_navigate':
        if (!/^https?:\/\//i.test(args.url)) throw new Error('Only HTTP/HTTPS navigation is supported');
        value = await this.navigate(page, args.url); break;
      case 'browser_snapshot': value = await page.evaluate(() => {
        const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
          .filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).slice(0, 180);
        const controls = elements.map((el, i) => {
          const ref = `e${i + 1}`; el.setAttribute('data-obscura-ref', ref);
          return { ref, tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 180) };
        });
        return { url: location.href, title: document.title, text: document.body.innerText.slice(0, 18000), controls };
      }); break;
      case 'browser_click': await target().click({ timeout: 10000 }); value = 'Clicked'; break;
      case 'browser_fill': await target().fill(String(args.value), { timeout: 10000 }); value = 'Filled'; break;
      case 'browser_press_key': await page.keyboard.press(args.key); value = 'Key pressed'; break;
      case 'browser_evaluate': value = await Promise.race([
        page.evaluate(expression => (0, eval)(expression), args.expression),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('JavaScript timeout')), 10000); timer.unref(); })
      ]); break;
      case 'browser_screenshot': return { content: [{ type: 'image', mimeType: 'image/png', data: (await page.screenshot({ timeout: 15000 })).toString('base64') }] };
      case 'browser_scroll': await page.mouse.wheel(0, Math.max(-10000, Math.min(10000, Number(args.y) || 0))); value = 'Scrolled'; break;
    }
    return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
  }
}
module.exports = { ChromeTools, definitions };
