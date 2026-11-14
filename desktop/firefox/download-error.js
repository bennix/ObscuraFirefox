document.getElementById('title').textContent = browser.i18n.getUILanguage().startsWith('zh') ? '媒体下载未能启动' : 'Media download could not start';
document.getElementById('message').textContent = new URLSearchParams(location.search).get('message') || '';
