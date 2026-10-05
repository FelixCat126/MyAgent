'use strict';
function createDocumentWorkbenchApi(ipcRenderer) {
  return {
    inspectDocument: (arg) => ipcRenderer.invoke('document-workbench-inspect', arg),
    renderDocumentPage: (arg) => ipcRenderer.invoke('document-workbench-page', arg),
    saveDocumentVersion: (arg) => ipcRenderer.invoke('document-workbench-save', arg),
    restoreDocumentVersion: (arg) => ipcRenderer.invoke('document-workbench-restore', arg),
    compareDocumentVersions: (arg) => ipcRenderer.invoke('document-workbench-compare', arg),
    calculateDocumentData: (arg) => ipcRenderer.invoke('document-workbench-calculate', arg),
    cancelDocumentOperation: (requestId) => ipcRenderer.send('document-workbench-cancel', requestId),
  };
}
module.exports = { createDocumentWorkbenchApi };
