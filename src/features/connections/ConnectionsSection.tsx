import { useEffect, useRef, useState } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiDownload, FiLink, FiArrowLeft, FiLoader, FiCheck } from 'react-icons/fi';
import { useConnectionStore, resolveModelConnection, type ServiceConnection } from '../../store/connectionStore';
import { useModelStore } from '../../store/modelStore';
import { useI18n } from '../../hooks/useI18n';
import { confirmDestructive } from '../../store/confirmStore';
import { HUB_INPUT, HUB_PRIMARY, HUB_SECONDARY, HUB_ICON, HUB_CARD, HUB_FORM, HUB_LABEL, HUB_HINT, HUB_BADGE, HUB_ERROR } from '../modelHub/styles';
const empty: Omit<ServiceConnection, 'updatedAt'> = { id: '', name: '', provider: 'openai', apiUrl: 'https://api.openai.com/v1', apiKey: '', chatApiMode: 'auto' };
type Discovery = { connectionId: string; signature?: string; phase: 'loading' | 'ready' | 'error'; models: string[]; error?: string };
const connectionSignature = (connection?: ServiceConnection) => connection && JSON.stringify([connection.provider, connection.apiUrl, connection.apiKey, connection.chatApiMode]);
export function ConnectionsSection({ cardShell, embedded = false }: { cardShell: string; embedded?: boolean }) {
  const { locale } = useI18n(); const label = (zh: string, en: string) => locale === 'en' ? en : zh;
  const { connections, saveConnection, removeConnection } = useConnectionStore(); const { models, addModel, updateModel } = useModelStore();
  const [draft, setDraft] = useState<typeof empty | null>(null); const [error, setError] = useState('');
  const [discovery, setDiscovery] = useState<Discovery | null>(null); const [selected, setSelected] = useState<string[]>([]);
  const requestId = useRef(0);
  const discoveryConnection = connections.find(c => c.id === discovery?.connectionId);
  const currentSignature = connectionSignature(discoveryConnection);
  const busy = discovery?.phase === 'loading';
  const available = discovery?.models ?? [];
  const existingIds = new Set(models.filter(m => m.connectionId === discovery?.connectionId).map(m => m.modelName.trim()));
  const pendingIds = selected.filter(id => available.includes(id) && !existingIds.has(id));
  const addedCount = available.filter(id => existingIds.has(id)).length;
  useEffect(() => () => { requestId.current += 1; }, []);
  useEffect(() => {
    if (!discovery || discovery.signature === currentSignature) return;
    requestId.current += 1;
    setSelected([]);
    setDiscovery({ ...discovery, signature: currentSignature, phase: 'error', models: [], error: discoveryConnection
      ? label('服务配置已变更，请重新发现模型。', 'Service settings changed. Discover models again.')
      : label('服务连接已删除，请返回选择其他服务。', 'The service was removed. Go back to choose another service.') });
  }, [currentSignature, discovery?.signature, discovery?.connectionId]);
  const back = () => { requestId.current += 1; setDraft(null); setDiscovery(null); setSelected([]); setError(''); };
  const remove = async (connection: ServiceConnection) => {
    const linked = models.filter(m => m.connectionId === connection.id || m.videoGeneratorConfig?.connectionId === connection.id);
    if (!await confirmDestructive(label(`删除连接“${connection.name}”？${linked.length} 个模型将保留当前地址和密钥并解除关联。`, `Delete ${connection.name}? ${linked.length} models will keep their effective settings.`))) return;
    for (const model of linked) {
      const effective = resolveModelConnection(model);
      const detachVideo = model.videoGeneratorConfig?.connectionId === connection.id;
      updateModel(model.id, { ...(model.connectionId === connection.id ? { ...effective, connectionId: undefined } : {}), ...(detachVideo && effective.videoGeneratorConfig ? { videoGeneratorConfig: { ...effective.videoGeneratorConfig, connectionId: undefined } } : {}) });
    }
    removeConnection(connection.id);
  };
  const discover = async (connection: ServiceConnection) => {
    const id = ++requestId.current;
    const signature = connectionSignature(connection);
    setError(''); setSelected([]); setDiscovery({ connectionId: connection.id, signature, phase: 'loading', models: [] });
    try {
      const result = await window.electron.discoverServiceModels(connection);
      if (id !== requestId.current) return;
      if (result?.error) throw new Error(result.error);
      const ids = [...new Set((Array.isArray(result?.models) ? result.models : []).map(m => typeof m?.id === 'string' ? m.id.trim() : '').filter(Boolean))];
      if (!ids.length) throw new Error(label('服务没有返回可用模型列表。可在“对话与图片”中选择此服务并手动填写模型名称。', 'No usable model list returned. Select this service in Chat & images and enter a model ID manually.'));
      setDiscovery({ connectionId: connection.id, signature, phase: 'ready', models: ids });
    } catch (e) {
      if (id !== requestId.current) return;
      const message = e instanceof Error ? e.message.trim() : String(e ?? '').trim();
      setDiscovery({ connectionId: connection.id, signature, phase: 'error', models: [], error: message || label('发现模型失败，请检查服务地址和密钥后重试。', 'Discovery failed. Check the service URL and key, then retry.') });
    }
  };
  const addSelected = () => {
    const connection = useConnectionStore.getState().connections.find(c => c.id === discovery?.connectionId);
    if (!connection || connectionSignature(connection) !== discovery?.signature) return;
    for (const id of pendingIds) {
      if (useModelStore.getState().models.some(m => m.connectionId === connection.id && m.modelName.trim() === id)) continue;
      addModel(resolveModelConnection({ id: crypto.randomUUID(), name: id, modelName: id, connectionId: connection.id, provider: connection.provider, apiUrl: connection.apiUrl, apiKey: connection.apiKey, chatApiMode: connection.chatApiMode, isLocal: connection.provider === 'ollama', maxTokens: 4096, isChatModel: true }));
    }
    back();
  };
  const editing = Boolean(draft?.id && connections.some(c => c.id === draft.id));
  return <section className={`${cardShell} ${embedded ? '' : 'p-3'} space-y-4`} aria-label={label('服务连接', 'Service connections')}>
    <div className="flex items-center justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-semibold text-stone-800 dark:text-white">{draft ? label(editing ? '编辑服务连接' : '添加服务连接', editing ? 'Edit service connection' : 'Add service connection') : discovery ? label('选择服务模型', 'Choose service models') : label('服务连接', 'Service connections')}</h3><p className={`${HUB_HINT} mt-1`}>{label('每个服务配置一次地址和密钥，多个模型共用。', 'Set the URL and key once for each service.')}</p></div>{draft || discovery ? <button className={HUB_SECONDARY} onClick={back}><FiArrowLeft />{label('返回', 'Back')}</button> : <button aria-label={label('添加服务连接', 'Add service connection')} className={HUB_PRIMARY} onClick={() => { setDraft({ ...empty, id: crypto.randomUUID() }); setError(''); }}><FiPlus />{label('添加', 'Add')}</button>}</div>
    {error && <p role="alert" className={HUB_ERROR}>{error}</p>}
    {draft ? <form className={HUB_FORM} onSubmit={e => { e.preventDefault(); try { saveConnection(draft); back(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}>
      <label className={HUB_LABEL}><span>{label('连接名称', 'Connection name')}</span><input required autoFocus className={HUB_INPUT} value={draft.name} placeholder={label('例如：MiniMax、本地 Ollama', 'e.g. MiniMax or local Ollama')} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className={HUB_LABEL}><span>{label('接口类型', 'Provider')}</span><select className={HUB_INPUT} value={draft.provider} onChange={e => setDraft({ ...draft, provider: e.target.value as ServiceConnection['provider'] })}>{[['openai', 'OpenAI'], ['claude', 'Anthropic'], ['ollama', 'Ollama'], ['custom', label('兼容接口', 'Compatible API')], ['gemini', 'Gemini']].map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
      <label className={HUB_LABEL}><span>{label('服务地址', 'Service URL')}</span><input required type="url" className={HUB_INPUT} value={draft.apiUrl} onChange={e => setDraft({ ...draft, apiUrl: e.target.value })} /></label>
      <label className={HUB_LABEL}><span>API Key</span><input type="password" autoComplete="off" className={HUB_INPUT} value={draft.apiKey} onChange={e => setDraft({ ...draft, apiKey: e.target.value })} /></label>
      <label className={HUB_LABEL}><span>{label('对话协议', 'Protocol')}</span><select className={HUB_INPUT} value={draft.chatApiMode ?? 'auto'} onChange={e => setDraft({ ...draft, chatApiMode: e.target.value as ServiceConnection['chatApiMode'] })}><option value="auto">{label('自动识别', 'Automatic')}</option><option value="openai">OpenAI (O)</option><option value="anthropic">Anthropic (A)</option></select></label>
      <div className="flex flex-wrap gap-2 border-t border-stone-200 pt-3 dark:border-slate-700"><button className={HUB_PRIMARY} type="submit">{label('保存连接', 'Save')}</button><button type="button" className={HUB_SECONDARY} onClick={back}>{label('取消', 'Cancel')}</button></div>
    </form> : discovery ? <div className={HUB_FORM} aria-busy={busy}>
      <p className="break-all text-xs font-semibold text-stone-800 dark:text-slate-100">{discoveryConnection?.name ?? label('服务已移除', 'Service removed')}</p>
      {busy ? <p role="status" className={`${HUB_HINT} flex items-center gap-2`}><FiLoader className="animate-spin" />{label('正在读取模型列表…', 'Discovering models…')}</p> : discovery.phase === 'error' ? <>
        <p role="alert" className={HUB_ERROR}>{discovery.error}</p>
        <p className={HUB_HINT}>{label('模型发现不会更改已有配置。也可在“对话与图片”中选择此服务，手动添加模型。', 'Discovery keeps existing settings. You can also select this service in Chat & images and add a model manually.')}</p>
        <button disabled={!discoveryConnection} className={HUB_SECONDARY} onClick={() => discoveryConnection && void discover(discoveryConnection)}>{label('重试发现', 'Retry discovery')}</button>
      </> : <>
        <p role="status" className={HUB_HINT}>{label(`共 ${available.length} 个模型 · 已添加 ${addedCount} 个 · 待添加 ${pendingIds.length} 个`, `${available.length} models · ${addedCount} added · ${pendingIds.length} to add`)}</p>
        <div className="max-h-64 space-y-2 overflow-auto">{available.map(id => {
          const added = existingIds.has(id);
          const checked = added || selected.includes(id);
          return <label key={id} data-state={added ? 'added' : 'available'} className={`flex items-start gap-2 rounded-lg border p-2.5 text-sm font-medium ${added
            ? 'border-stone-200 bg-stone-100 text-stone-600 dark:border-slate-700 dark:bg-slate-800/75 dark:text-slate-300'
            : 'border-transparent bg-white text-stone-800 dark:bg-slate-900 dark:text-slate-100'}`}>
            <input type="checkbox" aria-label={id} className="peer sr-only" checked={checked} disabled={added} onChange={e => setSelected(e.target.checked ? [...selected, id] : selected.filter(v => v !== id))} />
            <span aria-hidden="true" className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-slate-900 ${checked
              ? 'border-teal-600 bg-teal-600 text-white dark:border-teal-400 dark:bg-teal-400 dark:text-slate-950'
              : 'border-stone-400 bg-white dark:border-slate-500 dark:bg-slate-950'}`}>
              {checked && <FiCheck className="h-3.5 w-3.5" strokeWidth={3} />}
            </span>
            <span className="min-w-0 flex-1 break-all">{id}</span>{added && <span className={`${HUB_BADGE} shrink-0`}>{label('已添加', 'Added')}</span>}
          </label>;
        })}</div>
        <button disabled={!pendingIds.length || !discoveryConnection} className={HUB_PRIMARY} onClick={addSelected}>{label(pendingIds.length ? `添加 ${pendingIds.length} 个模型` : '添加选中模型', pendingIds.length ? `Add ${pendingIds.length} models` : 'Add selected models')}</button>
      </>}
    </div> : <div className="space-y-2">
      {!connections.length && <div className={`${HUB_CARD} flex flex-col items-center py-7 text-center`}><FiLink size={22} className="mb-3 text-stone-400" /><p className="text-xs font-medium text-stone-700 dark:text-slate-200">{label('还没有服务连接', 'No service connections yet')}</p><p className={`${HUB_HINT} mt-1 max-w-72`}>{label('添加常用服务后，模型只需选择连接和填写名称。', 'Add a service so models only need a connection and model ID.')}</p></div>}
      {connections.map(connection => <div className={HUB_CARD} key={connection.id}><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-stone-800 dark:text-slate-100">{connection.name}</p><p className={`${HUB_HINT} mt-1 truncate`} title={connection.apiUrl}>{connection.apiUrl}</p></div><button title={label('编辑连接', 'Edit')} aria-label={label(`编辑连接 ${connection.name}`, `Edit ${connection.name}`)} className={HUB_ICON} onClick={() => { setDraft({ ...connection }); setError(''); }}><FiEdit2 size={14} /></button><button title={label('删除连接', 'Delete')} aria-label={label(`删除连接 ${connection.name}`, `Delete ${connection.name}`)} className={`${HUB_ICON} hover:!text-rose-600`} onClick={() => void remove(connection)}><FiTrash2 size={14} /></button></div><div className="mt-3 flex flex-wrap items-center gap-2"><span className={HUB_BADGE}>{connection.chatApiMode === 'anthropic' ? 'Anthropic · A' : connection.chatApiMode === 'openai' ? 'OpenAI · O' : label('自动协议', 'Auto protocol')}</span><span className={HUB_BADGE}>{label(`${models.filter(m => m.connectionId === connection.id || m.videoGeneratorConfig?.connectionId === connection.id).length} 个模型`, `${models.filter(m => m.connectionId === connection.id || m.videoGeneratorConfig?.connectionId === connection.id).length} models`)}</span><button title={label('发现模型', 'Discover models')} className={`${HUB_SECONDARY} ml-auto !min-h-8 !px-2 !py-1`} onClick={() => void discover(connection)}><FiDownload size={13} />{label('发现模型', 'Discover')}</button></div></div>)}
    </div>}
  </section>;
}
