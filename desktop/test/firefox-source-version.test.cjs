const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { applySource } = require('../firefox/apply-source.cjs');
const { version } = require('../firefox/manifest.json');

test('source integration registers the current workspace version for fresh installs and upgrades', async t => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-source-version-'));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  const provider = 'toolkit/mozapps/extensions/internal/XPIProvider.sys.mjs';
  for (const [name, content] of Object.entries({
    'browser/branding/unofficial/configure.sh': 'MOZ_APP_DISPLAYNAME=Nightly\nMOZ_MACBUNDLE_ID=nightlyunofficial\n',
    'browser/branding/unofficial/locales/en-US/brand.ftl': '-brand-short-name = Nightly\n',
    'browser/branding/unofficial/locales/en-US/brand.properties': 'brandShortName=Nightly\n',
    'browser/branding/unofficial/pref/firefox-branding.js': '',
    'browser/moz.build': '',
    'browser/installer/package-manifest.in': '',
    'toolkit/modules/ServiceRequest.sys.mjs': '',
    [provider]: '      resolveProviderReady(Promise.all(this.startupPromises));'
  })) {
    const file = path.join(source, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  await applySource(source);
  const fresh = await fs.readFile(path.join(source, provider), 'utf8');
  assert.ok(fresh.includes(`this.maybeInstallBuiltinAddon("workspace@obscura.local", "${version}"`));
  await fs.writeFile(path.join(source, provider), fresh.replace(`"${version}"`, '"0.3.4"'));
  await applySource(source);
  const upgraded = await fs.readFile(path.join(source, provider), 'utf8');
  assert.equal(upgraded, fresh);
});
