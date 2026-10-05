import { app, ipcMain } from 'electron';
import path from 'node:path';
import type { DocumentFormat } from '../../src/types/document';
import { DocumentWorkbenchService } from './service';
export function registerDocumentWorkbenchIPC(writer: (arg: { format: DocumentFormat; content: string; defaultBaseName: string }) => Promise<Buffer>) {
  let service: DocumentWorkbenchService | undefined;
  const getService = () => service ??= new DocumentWorkbenchService(path.join(app.getPath('userData'), 'document-workbench'), path.join(app.getPath('documents'), 'MyAgent', 'DataResults'), writer);
  const operations = new Map<string, { controller: AbortController; sender: number }>();
  ipcMain.on('document-workbench-cancel', (event, requestId: string) => { const operation = operations.get(requestId); if (operation?.sender === event.sender.id) operation.controller.abort(); });
  const handlers = {
    'document-workbench-inspect': (arg: Parameters<DocumentWorkbenchService['inspect']>[0], signal: AbortSignal) => getService().inspect(arg, signal).then((document) => ({ document })),
    'document-workbench-page': (arg: Parameters<DocumentWorkbenchService['renderPage']>[0], signal: AbortSignal) => getService().renderPage(arg, signal),
    'document-workbench-save': (arg: Parameters<DocumentWorkbenchService['save']>[0], signal: AbortSignal) => getService().save(arg, signal),
    'document-workbench-restore': (arg: Parameters<DocumentWorkbenchService['restore']>[0], signal: AbortSignal) => getService().restore(arg, signal),
    'document-workbench-compare': (arg: Parameters<DocumentWorkbenchService['compare']>[0]) => getService().compare(arg),
    'document-workbench-calculate': (arg: Parameters<DocumentWorkbenchService['calculate']>[0], signal: AbortSignal) => getService().calculate(arg, signal).then((result) => ({ result })),
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, async (event, arg: { requestId?: string }) => {
    const id = typeof arg?.requestId === 'string' && arg.requestId.length < 100 ? arg.requestId : `${event.sender.id}:${Date.now()}:${Math.random()}`;
    if (operations.has(id)) return { ok: false, error: '此请求已在运行 / Request already running' };
    const controller = new AbortController(); operations.set(id, { controller, sender: event.sender.id });
    const onDestroyed = () => controller.abort(); event.sender.once('destroyed', onDestroyed);
    try { if (!arg || typeof arg !== 'object') throw new Error('无效请求 / Invalid request'); const result = await (handler as (arg: unknown, signal: AbortSignal) => Promise<object>)(arg, controller.signal); return { ok: true, ...result }; }
    catch (e) { const error = controller.signal.aborted ? 'DOCUMENT_CANCELED' : e instanceof Error ? e.message : String(e); return { ok: false, error, canceled: error === 'DOCUMENT_CANCELED' }; }
    finally { event.sender.removeListener('destroyed', onDestroyed); operations.delete(id); }
  });
}
