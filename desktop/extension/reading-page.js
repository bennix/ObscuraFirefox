(() => {
  if (globalThis.__obscuraReading) return;
  const blocks = new Map();
  let sequence = 0;
  function content(element) {
    const copy = element.cloneNode(true);
    copy.querySelectorAll('[data-obscura-translation]').forEach(node => node.remove());
    return copy.textContent.trim();
  }
  globalThis.__obscuraReading = {
    collect() {
      const batch = [];
      let length = 0;
      for (const element of document.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,dd')) {
        if (element.closest('script,style,pre,code,textarea,input,[contenteditable], [data-obscura-translation]') || element.querySelector('p,li,blockquote,td,dd') || !element.getClientRects().length) continue;
        const original = content(element);
        if (!original || original.length < 2 || !/[\p{L}]/u.test(original)) continue;
        let id = element.dataset.obscuraParagraph;
        let record = blocks.get(id);
        if (!record || record.original !== original) {
          element.querySelectorAll('[data-obscura-translation]').forEach(node => node.remove());
          id = String(++sequence);
          element.dataset.obscuraParagraph = id;
          const chunks = original.match(/[\s\S]{1,3000}/g);
          record = { element, original, chunks, translated: new Map() };
          blocks.set(id, record);
        }
        for (let index = 0; index < record.chunks.length; index++) {
          if (record.translated.has(index)) continue;
          const text = record.chunks[index];
          if (batch.length === 6 || length + text.length > 10000) return batch;
          batch.push({ id: id + ':' + index, text }); length += text.length;
        }
      }
      return batch;
    },
    apply(translations) {
      let applied = 0;
      for (const translation of translations) {
        const [id, chunk] = translation.id.split(':');
        const record = blocks.get(id);
        const index = Number(chunk);
        if (!record?.element.isConnected || content(record.element) !== record.original || record.chunks[index] !== translation.original) continue;
        record.translated.set(index, translation.text);
        let output = record.element.querySelector(':scope > [data-obscura-translation]');
        if (!output) {
          output = document.createElement('span');
          output.dataset.obscuraTranslation = 'true';
          output.style.cssText = 'display:block;font:inherit;color:inherit;line-height:inherit;margin-top:.45em;opacity:.85;white-space:pre-wrap';
          record.element.append(output);
        }
        output.textContent = [...record.translated.entries()].sort((a, b) => a[0] - b[0]).map(item => item[1]).join('');
        applied++;
      }
      return applied;
    },
    clear() {
      document.querySelectorAll('[data-obscura-translation]').forEach(node => node.remove());
      blocks.clear();
    }
  };
  document.addEventListener('mouseup', () => {
    setTimeout(() => {
      const selection = getSelection();
      const word = selection?.toString().trim();
      if (!word || word.length > 200 || !selection.rangeCount) return;
      const node = selection.anchorNode?.parentElement;
      if (node?.closest('input,textarea,[contenteditable]')) return;
      const paragraph = node?.closest('p,li,blockquote,td,dd') || node;
      const paragraphText = paragraph ? content(paragraph) : word;
      const sentences = new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: 'sentence' }).segment(paragraphText);
      const sentence = [...sentences].find(item => item.segment.includes(word));
      const context = (sentence?.segment || paragraphText).trim().slice(0, 4000);
      globalThis.obscuraSelection?.(JSON.stringify({ word, context, sourceURL: location.href, sourceTitle: document.title }));
    }, 0);
  });
})();
