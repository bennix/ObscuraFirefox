if (parent !== window && parent.obscuraHost) {
  globalThis.BRIDGE = parent.obscuraHost.bridge;
  globalThis.workspace = parent.obscuraHost;
  document.body.classList.add('embedded');
  document.getElementById('sidepanel').textContent = '收起工作台';
} else {
  globalThis.workspace = {
    message: data => chrome.runtime.sendMessage(data),
    openTab: url => chrome.tabs.create({ url }),
    openPanel: async () => {
      const window = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: window.id });
    }
  };
}
