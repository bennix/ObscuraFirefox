const fs = require('node:fs/promises');
const path = require('node:path');

const currentVersion = '0.3.15';
const repository = 'bennix/ObscuraFirefox';
const day = 24 * 60 * 60 * 1000;

function newerRelease(tag, current = currentVersion) {
  const match = /^firefox-v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) return false;
  const installed = current.split('.').map(Number);
  const difference = match[1].split('.').map((part, index) => Number(part) - installed[index]);
  return difference.find(value => value !== 0) > 0;
}

async function checkUpdates(directory, transport, tools) {
  if (!tools.browserClient.open) return;
  const file = path.join(directory, 'update-check.json');
  let state = {};
  try { state = JSON.parse(await fs.readFile(file, 'utf8')) || {}; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const elapsed = Date.now() - state.checked;
  if (elapsed >= 0 && elapsed < day) return;
  const response = await transport.fetch('https://api.github.com/repos/' + repository + '/releases/latest', {
    headers: { 'User-Agent': 'ObscuraFirefox-UpdateCheck' }, signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('Release lookup failed: ' + response.status);
  const release = await response.json();
  if (!release.draft && !release.prerelease && newerRelease(release.tag_name) && release.tag_name !== state.notified) {
    await tools.request('browser_new_tab', { url: 'https://github.com/' + repository + '/releases/tag/' + release.tag_name });
    state.notified = release.tag_name;
  }
  state.checked = Date.now();
  await fs.writeFile(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
}

module.exports = { checkUpdates, newerRelease };
