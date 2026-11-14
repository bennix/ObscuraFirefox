let translationController, translationTab, lookupEntry, lookupSource = {}, dictionaryPage = 1, dictionaryRequest = 0;
async function readingPage(tab, action, translations) {
  if (!workspace.standalone) throw new Error('请在独立桌面应用中使用网页翻译');
  return workspace.message({ type: 'reading-page', tabId: tab.id, expectedURL: tab.url, action, translations });
}
$('translation-language').onchange = () => run(() => request('/settings', { translationLanguage: $('translation-language').value }));
$('translate-start').onclick = async () => {
  if (translationController) return;
  const controller = new AbortController();
  translationController = controller;
  $('translate-start').disabled = true; $('translate-stop').disabled = false;
  let count = 0;
  try {
    translationTab = await workspace.message({ type: 'active-tab' });
    await request('/settings', { translationLanguage: $('translation-language').value });
    while (!controller.signal.aborted) {
      const segments = await readingPage(translationTab, 'collect');
      if (!segments.length) { $('translation-status').textContent = `已完成当前已加载内容，共 ${count} 段。滚动加载新内容后可继续翻译。`; break; }
      $('translation-status').textContent = `已翻译 ${count} 段，正在处理下一批 ${segments.length} 段…`;
      const response = await fetch(BRIDGE.origin + '/translate', { method: 'POST', headers: { 'X-Obscura-Token': BRIDGE.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ segments }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '翻译请求失败');
      controller.signal.throwIfAborted();
      const applied = await readingPage(translationTab, 'apply', result.translations);
      count += applied;
      if (!applied) throw new Error('网页内容已变化，请重新开始翻译');
    }
  } catch (error) { $('translation-status').textContent = controller.signal.aborted ? `已停止，保留 ${count} 段译文` : error.message; }
  finally { translationController = null; $('translate-start').disabled = false; $('translate-stop').disabled = true; }
};
$('translate-stop').onclick = () => translationController?.abort();
$('translate-clear').onclick = () => run(async () => {
  translationController?.abort();
  await readingPage(await workspace.message({ type: 'active-tab' }), 'clear');
  $('translation-status').textContent = '已恢复原文';
});
async function lookupSelection(selection) {
  if (!selection) return;
  lookupSource = selection;
  $('lookup-word').value = selection.word || '';
  $('lookup-context').value = selection.context || '';
  await queryWord();
}
async function queryWord() {
  $('lookup-query').disabled = true; $('lookup-result').hidden = true; lookupEntry = null;
  try {
    status('正在根据原句查询…');
    lookupEntry = await request('/lookup', { ...lookupSource, word: $('lookup-word').value, context: $('lookup-context').value });
    $('lookup-pos').textContent = '词性 · ' + lookupEntry.partOfSpeech;
    $('lookup-translation').textContent = lookupEntry.translation;
    $('lookup-explanation').textContent = lookupEntry.explanation;
    $('lookup-result').hidden = false; $('lookup-save').disabled = false; $('lookup-save').textContent = '加入用户词典';
    status('查询完成');
  } catch (error) { status(error.message, true); }
  finally { $('lookup-query').disabled = false; }
}
$('lookup-query').onclick = queryWord;
window.addEventListener('message', event => {
  if (event.source === parent && event.origin === location.origin && event.data?.type === 'obscura-lookup') lookupSelection(event.data.selection);
});
$('lookup-save').onclick = () => run(async () => {
  if (!lookupEntry) return;
  $('lookup-save').disabled = true;
  try { await request('/dictionary/save', lookupEntry); $('lookup-save').textContent = '已保存'; await loadDictionary(1); }
  catch (error) { $('lookup-save').disabled = false; throw error; }
});
async function loadDictionary(page = dictionaryPage) {
  const sequence = ++dictionaryRequest;
  try {
    const result = await request('/dictionary?q=' + encodeURIComponent($('dictionary-search').value) + '&page=' + page);
    if (sequence !== dictionaryRequest) return;
    dictionaryPage = result.page;
    $('dictionary-page').textContent = `${result.page} / ${result.pages} · ${result.total} 条`;
    $('dictionary-prev').disabled = result.page <= 1; $('dictionary-next').disabled = result.page >= result.pages;
    const cards = result.entries.map(entry => {
      const card = document.createElement('article'); card.className = 'dictionary-card';
      const word = document.createElement('strong'); word.textContent = entry.word;
      const pos = document.createElement('small'); pos.textContent = entry.partOfSpeech;
      const translation = document.createElement('p'); translation.textContent = entry.translation;
      const context = document.createElement('blockquote'); context.textContent = entry.context;
      const explanation = document.createElement('p'); explanation.className = 'muted'; explanation.textContent = entry.explanation;
      card.append(word, pos, translation, context, explanation);
      if (/^https?:\/\//i.test(entry.sourceURL)) {
        const source = document.createElement('button'); source.textContent = entry.sourceTitle || '查看原文';
        source.onclick = () => workspace.openTab(entry.sourceURL); card.append(source);
      }
      return card;
    });
    if (!cards.length) { const empty = document.createElement('p'); empty.textContent = '没有匹配的词条'; cards.push(empty); }
    $('dictionary-list').replaceChildren(...cards);
  } catch (error) { status(error.message, true); }
}
let dictionaryTimer;
$('dictionary-search').oninput = () => { clearTimeout(dictionaryTimer); dictionaryTimer = setTimeout(() => loadDictionary(1), 250); };
$('dictionary-prev').onclick = () => loadDictionary(dictionaryPage - 1);
$('dictionary-next').onclick = () => loadDictionary(dictionaryPage + 1);
document.querySelector('[data-tab="reading"]').addEventListener('click', () => loadDictionary());
