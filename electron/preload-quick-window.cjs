const { contextBridge, ipcRenderer } = require('electron');
const listen = (channel, callback) => { const listener = (_event, value) => callback(value); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
const quickAgent = {
  send: text => ipcRenderer.invoke('quick-panel-send', text),
  cancel: id => ipcRenderer.invoke('quick-panel-cancel', id),
  hide: () => ipcRenderer.invoke('quick-panel-hide'),
  open: sessionId => ipcRenderer.invoke('quick-panel-open', sessionId),
  onFocus: callback => listen('quick-panel-focus', callback),
  onUpdate: callback => listen('quick-panel-update', callback),
};
if (process.contextIsolated) contextBridge.exposeInMainWorld('quickAgent', quickAgent);
else window.quickAgent = quickAgent;
