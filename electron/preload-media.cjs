'use strict';
function createMediaWorkbenchApi(ipcRenderer) {
  return {
    chooseMediaReference: () => ipcRenderer.invoke('media-workbench-reference'),
    readMediaVersions: (arg) => ipcRenderer.invoke('media-workbench-versions', arg),
  };
}
module.exports = { createMediaWorkbenchApi };
