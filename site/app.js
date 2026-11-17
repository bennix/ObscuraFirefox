const button=document.getElementById('language');
let language=new URLSearchParams(location.search).get('lang')||localStorage.getItem('obscura-language')||(navigator.language.startsWith('zh')?'zh':'en');
function render(){language=language==='zh'?'zh':'en';document.documentElement.lang=language==='zh'?'zh-CN':'en';document.querySelectorAll('[data-en]').forEach(node=>{node.innerHTML=node.dataset[language]||node.dataset.en});button.textContent=language==='zh'?'English':'中文';document.title=language==='zh'?'Obscura Firefox — 把网页变成行动。':'Obscura Firefox — Make the web yours.';localStorage.setItem('obscura-language',language)}
button.onclick=()=>{language=language==='zh'?'en':'zh';render()};render();
// Verified release links remain usable if the GitHub API is unavailable.
fetch('https://api.github.com/repos/bennix/ObscuraFirefox/releases/latest')
  .then(response => response.ok ? response.json() : null)
  .then(release => {
    if (!release) return;
    const patterns = {mac:/-macos-arm64\.dmg$/,'mac-intel':/-macos-x64\.dmg$/,windows:/-windows-x64-setup\.exe$/,deb:/-linux-amd64\.deb$/,rpm:/-linux-x86_64\.rpm$/};
    const updates = [];
    for (const [platform, pattern] of Object.entries(patterns)) {
      const asset = (release.assets || []).find(item => pattern.test(item.name));
      if (!asset?.browser_download_url?.startsWith('https://github.com/bennix/ObscuraFirefox/releases/download/')) continue;
      updates.push([platform, asset.browser_download_url]);
    }
    if (updates.length === Object.keys(patterns).length && /^firefox-v[0-9.]+$/.test(release.tag_name)) {
      for (const [platform, href] of updates) document.querySelector(`[data-platform="${platform}"]`).href = href;
      document.querySelector('.release-version').textContent = release.tag_name.replace('firefox-', '');
      document.querySelector('.release-notes').href = 'https://github.com/bennix/ObscuraFirefox/releases/tag/' + release.tag_name;
    }
  }).catch(() => {});
