(() => {
  let host;
  function open(url) {
    if (host) host.remove();
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>:host{all:initial}*{box-sizing:border-box}.overlay{position:fixed;inset:0;background:#0b0d0bf5;color:#e9eee5;font:13px system-ui;display:block}.bar{position:absolute;inset:0 0 auto;height:66px;display:flex;align-items:center;justify-content:space-between;padding:16px 25px;z-index:2;background:#111e}.bar>div{display:flex;gap:10px;align-items:center}button{background:#20251f;border:1px solid #4a5741;color:#d1f28a;border-radius:6px;padding:9px 13px;cursor:pointer;font:13px system-ui}#stage{position:absolute;inset:66px 0 48px;overflow:hidden;cursor:grab;touch-action:none}#stage:active{cursor:grabbing}img{position:absolute;left:50%;top:50%;max-width:none;max-height:none;transform-origin:center;user-select:none}#help{position:absolute;bottom:12px;left:0;right:0;text-align:center;color:#aab5a3;font-size:12px}</style><div class="overlay" role="dialog" aria-modal="true" aria-label="Obscura 图片查看器"><div class="bar"><span>OBSCURA / IMAGE EXPLORER</span><div><button id="out" aria-label="缩小">−</button><span id="percent">100%</span><button id="in" aria-label="放大">＋</button><button id="fit">适应窗口</button><button id="close">关闭 esc</button></div></div><div id="stage"><img id="image" draggable="false" alt="展开的图片"></div><div id="help">正在载入原图…</div></div>`;
    document.documentElement.appendChild(host);
    const $ = id => shadow.getElementById(id), img = $('image'), stage = $('stage');
    let scale = 1, x = 0, y = 0, drag;
    const draw = () => { img.style.transform = `translate(calc(-50% + ${x}px),calc(-50% + ${y}px)) scale(${scale})`; $('percent').textContent = Math.round(scale * 100) + '%'; };
    const fit = () => { scale = Math.min(1, (stage.clientWidth - 50) / img.naturalWidth, (stage.clientHeight - 40) / img.naturalHeight); x = y = 0; draw(); };
    const zoom = (factor, px = 0, py = 0) => { const next = Math.max(.05, Math.min(12, scale * factor)), r = next / scale; x = px - (px - x) * r; y = py - (py - y) * r; scale = next; draw(); };
    const close = () => { host.remove(); host = null; document.removeEventListener('keydown', key, true); window.removeEventListener('resize', fit); };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
    $('close').onclick = close; $('fit').onclick = fit; $('in').onclick = () => zoom(1.25); $('out').onclick = () => zoom(.8);
    stage.addEventListener('wheel', event => { event.preventDefault(); event.stopPropagation(); const r = stage.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .002), event.clientX - r.left - r.width / 2, event.clientY - r.top - r.height / 2); }, { passive: false });
    stage.onpointerdown = event => { drag = { x: event.clientX - x, y: event.clientY - y }; stage.setPointerCapture(event.pointerId); };
    stage.onpointermove = event => { if (drag) { x = event.clientX - drag.x; y = event.clientY - drag.y; draw(); } };
    stage.onpointerup = stage.onpointercancel = () => { drag = null; }; stage.ondblclick = fit;
    img.onload = () => { fit(); $('help').textContent = '滚轮缩放 · 拖拽平移 · 双击复位'; };
    img.onerror = () => { $('help').textContent = '原图加载失败，请关闭后重试'; };
    img.src = url;
    document.addEventListener('keydown', key, true); window.addEventListener('resize', fit);
    $('close').focus();
  }
  document.addEventListener('click', event => {
    const img = event.target.closest?.('img');
    if (!img) return;
    const isX = /(^|\.)(x\.com|twitter\.com)$/.test(location.hostname);
    let url;
    try { url = new URL(img.currentSrc || img.src); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (!(isX && url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) && !event.altKey) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (url.hostname === 'pbs.twimg.com') url.searchParams.set('name', 'orig');
    open(url.href);
  }, true);
})();
