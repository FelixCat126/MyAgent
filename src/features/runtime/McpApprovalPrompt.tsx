import { useState } from 'react';
import type { McpCallResult } from './api';

export type PendingMcpApproval = NonNullable<McpCallResult['authorizationRequired']> & { connectionName?: string };

/** 外部工具写操作的单次审批浮层：Agent 等待期间直接在主界面给出批准 / 拒绝入口 */
export default function McpApprovalPrompt({ approvals, locale, onSettled }: { approvals: PendingMcpApproval[]; locale: string; onSettled: (id: string) => void }) {
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  if (!approvals.length) return null;
  const en = locale === 'en';
  const act = async (id: string, approve: boolean) => {
    setBusyId(id);
    setError('');
    try {
      if (approve) await window.electron.runtimeApproveMcpCall(id);
      else await window.electron.runtimeCancelMcpCall(id);
      onSettled(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 批准失效（过期/已取消）时同样移除，避免残留无效入口
      onSettled(id);
    } finally {
      setBusyId('');
    }
  };
  return (
    <div role="alertdialog" aria-label={en ? 'External tool approval' : '外部工具审批'} className="fixed bottom-5 right-5 z-[60] w-[min(420px,calc(100vw-2.5rem))] space-y-3">
      {approvals.map((approval) => (
        <div key={approval.id} className="space-y-2 rounded-xl border border-amber-400 bg-white p-4 text-stone-800 shadow-xl dark:border-amber-700 dark:bg-slate-900 dark:text-slate-100">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {en ? 'The assistant requests' : '助手请求执行外部工具'} <code>{approval.tool}</code>
            {approval.connectionName ? ` (${approval.connectionName})` : ''}
          </p>
          <p className="text-xs text-stone-500 dark:text-slate-400">
            {en ? 'This may modify external data. Approve only this call?' : '此操作可能修改外部数据，是否仅批准本次调用？'}
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-2 text-xs dark:bg-slate-800">{JSON.stringify(approval.args, null, 2)}</pre>
          <div className="flex justify-end gap-2">
            <button type="button" disabled={busyId === approval.id} onClick={() => void act(approval.id, false)} className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-700">
              {en ? 'Reject' : '拒绝'}
            </button>
            <button type="button" disabled={busyId === approval.id} onClick={() => void act(approval.id, true)} className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700 disabled:opacity-40">
              {en ? 'Approve this call' : '批准本次调用'}
            </button>
          </div>
        </div>
      ))}
      {error && <p className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    </div>
  );
}
