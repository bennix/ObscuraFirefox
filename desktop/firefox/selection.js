async function showSelectedWord(selection) {
  if (!selection?.word) return;
  document.querySelector('[data-tab="reading"]').click();
  await lookupSelection(selection);
}
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.lookupSelection?.newValue) showSelectedWord(changes.lookupSelection.newValue);
});
browser.storage.session.get('lookupSelection').then(({ lookupSelection: selection }) => {
  if (selection && Date.now() - selection.requestedAt < 10000) showSelectedWord(selection);
});
