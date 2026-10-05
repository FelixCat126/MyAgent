function createRuntimeApi(ipcRenderer) {
  const invoke = (channel) => (value) => ipcRenderer.invoke(channel, value);
  const listen = (channel) => (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
  return {
    runtimeGetState: invoke('runtime-get-state'), runtimeCreateTask: invoke('runtime-create-task'),
    runtimeClaimTask: invoke('runtime-claim-task'), runtimeStartTask: invoke('runtime-start-task'), runtimeRetryTask: invoke('runtime-retry-task'),
    runtimeCompleteTask: invoke('runtime-complete-task'), runtimeRecordStep: invoke('runtime-record-step'),
    runtimeSaveCheckpoint: invoke('runtime-save-checkpoint'), runtimeCancelTask: invoke('runtime-cancel-task'),
    runtimeSaveSchedule: invoke('runtime-save-schedule'), runtimeDeleteSchedule: invoke('runtime-delete-schedule'),
    runtimeRunSchedule: invoke('runtime-run-schedule'), runtimeChooseDirectory: invoke('runtime-choose-directory'),
    runtimeSaveConnection: invoke('runtime-save-connection'), runtimeConnect: invoke('runtime-connect'),
    runtimeDisconnect: invoke('runtime-disconnect'), runtimeDeleteConnection: invoke('runtime-delete-connection'),
    runtimeListTools: invoke('runtime-list-tools'), runtimeCallTool: invoke('runtime-call-tool'),
    runtimeApproveMcpCall: invoke('runtime-approve-mcp-call'), runtimeCancelMcpCall: invoke('runtime-cancel-mcp-call'),
    runtimeExportBackup: invoke('runtime-export-backup'), runtimePreviewBackup: invoke('runtime-preview-backup'),
    runtimeRestoreBackup: invoke('runtime-restore-backup'), runtimeListSnapshots: invoke('runtime-list-snapshots'), runtimeRollbackBackup: invoke('runtime-rollback-backup'),
    onRuntimeChanged: listen('runtime-changed'), onRuntimeTaskDispatch: listen('runtime-task-dispatch'),
    onRuntimeTaskCancel: listen('runtime-task-cancel'), onRuntimeMcpResult: listen('runtime-mcp-result'),
  };
}
module.exports = { createRuntimeApi };
