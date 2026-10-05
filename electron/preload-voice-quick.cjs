function createVoiceQuickApi(ipcRenderer) {
  const listen = channel => callback => { const listener = (_event,value) => callback(value); ipcRenderer.on(channel,listener); return () => ipcRenderer.removeListener(channel,listener); };
  return {
    showQuickPanel: () => ipcRenderer.invoke('quick-panel-show'),
    quickReplyUpdate: update => ipcRenderer.invoke('quick-panel-update',update),
    onQuickSubmit: listen('quick-panel-submit'),
    onQuickCancel: listen('quick-panel-cancel'),
    onQuickOpenSession: listen('quick-panel-open-session'),
  };
}
module.exports = { createVoiceQuickApi };
