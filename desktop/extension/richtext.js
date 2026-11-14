(() => {
  function readMath(source, blockOnly) {
    const delimiters = blockOnly ? [['$$', '$$', true], ['\\[', '\\]', true]]
      : [['$$', '$$', true], ['\\[', '\\]', true], ['\\(', '\\)', false], ['$', '$', false]];
    for (const [opening, closing, displayMode] of delimiters) {
      if (!source.startsWith(opening)) continue;
      let end = source.indexOf(closing, opening.length);
      while (end !== -1) {
        let escapes = 0;
        for (let index = end - 1; index >= 0 && source[index] === '\\'; index--) escapes++;
        if (escapes % 2 === 0) break;
        end = source.indexOf(closing, end + closing.length);
      }
      if (end === -1) return;
      const text = source.slice(opening.length, end);
      if (!displayMode && text.includes('\n')) return;
      return { raw: source.slice(0, end + closing.length), text, displayMode };
    }
  }

  function mathExtension(name, level) {
    return {
      name, level,
      start: source => level === 'block' ? source.search(/\$\$|\\\[/) : source.search(/\$|\\[([]/),
      tokenizer(source) {
        const token = readMath(source, level === 'block');
        if (token) return { type: name, ...token };
      },
      renderer(token) {
        return katex.renderToString(token.text, {
          displayMode: token.displayMode,
          throwOnError: false,
          trust: false,
          strict: 'ignore',
          maxExpand: 1000
        });
      }
    };
  }

  marked.use({ extensions: [mathExtension('mathBlock', 'block'), mathExtension('mathInline', 'inline')] });
  globalThis.renderRichText = (element, source) => {
    const html = marked.parse(source, { gfm: true, breaks: true, async: false });
    element.innerHTML = DOMPurify.sanitize(html);
    element.querySelectorAll('a').forEach(link => {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });
  };
})();
