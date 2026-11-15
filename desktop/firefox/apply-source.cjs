const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
async function applySource(source) {
  if (!source) throw new Error('Usage: node apply-source.cjs FIREFOX_SOURCE');
  const branding = path.join(source, 'browser/branding/obscura');
  await fs.cp(path.join(source, 'browser/branding/unofficial'), branding, { recursive: true });
  const configure = path.join(branding, 'configure.sh');
  let config = await fs.readFile(configure, 'utf8');
  config = config.replace('MOZ_APP_DISPLAYNAME=Nightly', 'MOZ_APP_DISPLAYNAME="Obscura"').replace('MOZ_MACBUNDLE_ID=nightlyunofficial', 'MOZ_MACBUNDLE_ID=ai.obscura.firefox');
  await fs.writeFile(configure, config);
  for (const file of ['locales/en-US/brand.ftl', 'locales/en-US/brand.properties']) {
    const target = path.join(branding, file);
    let text = await fs.readFile(target, 'utf8');
    text = text.replace(/^(.*=\s*)Nightly$/gm, '$1Obscura').replace(/^-brand-product-name = Firefox$/m, '-brand-product-name = Obscura').replace(/^-vendor-short-name = Mozilla$/m, '-vendor-short-name = Obscura');
    await fs.writeFile(target, text);
  }
  const prefs = await fs.readFile(path.join(__dirname, 'privacy-prefs.js'), 'utf8');
  await fs.appendFile(path.join(branding, 'pref/firefox-branding.js'), '\n' + prefs);
  await fs.cp(path.join(__dirname, 'branding/generated'), branding, { recursive: true });
  const workspace = path.join(source, 'browser/obscura-workspace');
  const extension = path.join(workspace, 'extension');
  await require('./prepare-extension.cjs').prepareExtension(extension);
  const lines = [];
  async function collect(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await collect(path.join(directory, entry.name), name);
      else {
        const parts = relative ? relative.split('/') : [];
        const destination = ['obscura-workspace', ...parts].map(part => `[${JSON.stringify(part)}]`).join('');
        lines.push(`FINAL_TARGET_FILES${destination} += [${JSON.stringify('extension/' + name)}]`);
      }
    }
  }
  await collect(extension);
  await fs.writeFile(path.join(workspace, 'moz.build'), lines.join('\n') + '\n');
  const browserBuild = path.join(source, 'browser/moz.build');
  const buildText = await fs.readFile(browserBuild, 'utf8');
  if (!buildText.includes('DIRS += ["obscura-workspace"]')) await fs.appendFile(browserBuild, '\nDIRS += ["obscura-workspace"]\n');
  const provider = path.join(source, 'toolkit/mozapps/extensions/internal/XPIProvider.sys.mjs');
  let providerText = await fs.readFile(provider, 'utf8');
  const anchor = '      resolveProviderReady(Promise.all(this.startupPromises));';
  if (!providerText.includes('"workspace@obscura.local"')) {
    if (!providerText.includes(anchor)) throw new Error('Firefox addon startup location changed');
    providerText = providerText.replace(anchor, '      if (Services.prefs.getBoolPref("obscura.workspace.enabled", false)) {\n        const workspaceDirectory = Services.dirsvc.get("GreD", Ci.nsIFile);\n        workspaceDirectory.append("browser");\n        workspaceDirectory.append("obscura-workspace");\n        Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler)\n          .setSubstitution("obscura-workspace", Services.io.newFileURI(workspaceDirectory));\n        this.maybeInstallBuiltinAddon("workspace@obscura.local", "0.3.4", "resource://obscura-workspace/");\n      }\n\n' + anchor);
    await fs.writeFile(provider, providerText);
  }
  const packageManifest = path.join(source, 'browser/installer/package-manifest.in');
  // getActivePolicies returns an object, including when our update policy is
  // active. This release incorrectly treats it as an array in proxy reporting.
  const serviceRequest = path.join(source, 'toolkit/modules/ServiceRequest.sys.mjs');
  let serviceText = await fs.readFile(serviceRequest, 'utf8');
  serviceText = serviceText.replace('let policies = Services.policies.getActivePolicies()?.filter(p => p.Proxy);\n    if (policies?.length)', 'let policies = Services.policies.getActivePolicies();\n    if (policies?.Proxy)');
  await fs.writeFile(serviceRequest, serviceText);
  const packageText = await fs.readFile(packageManifest, 'utf8');
  if (!packageText.includes('@RESPATH@/browser/obscura-workspace/*')) await fs.appendFile(packageManifest, '\n@RESPATH@/browser/obscura-workspace/*\n');
  for (const icon of ['document.icns', 'disk.icns']) await fs.copyFile(path.join(branding, 'firefox.icns'), path.join(branding, icon));
  const mozconfig = await fs.readFile(path.join(__dirname, 'mozconfig'), 'utf8');
  await fs.writeFile(path.join(source, 'mozconfig'), mozconfig + '\nac_add_options --with-branding=browser/branding/obscura\n');
}
if (require.main === module) applySource(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { applySource };
