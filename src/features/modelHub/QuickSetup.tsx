import { useEffect, useRef, useState } from 'react';
import { FiArrowLeft, FiCheckCircle, FiLoader, FiZap } from 'react-icons/fi';
import { useI18n } from '../../hooks/useI18n';
import { resolveModelConnection } from '../../store/connectionStore';
import { useModelStore } from '../../store/modelStore';
import { HUB_BADGE, HUB_CARD, HUB_ERROR, HUB_FORM, HUB_HINT, HUB_INPUT, HUB_LABEL, HUB_PRIMARY, HUB_SECONDARY } from './styles';
import { VENDOR_PRESETS, buildSetupPlan, classifyModelId, type SetupPlan, type VendorPreset } from './vendorCatalog';
import { applySetup, upsertVendorConnection, type SetupResult } from './quickSetupApply';

type Step =
  | { phase: 'pick' }
  | { phase: 'key'; vendor: VendorPreset; discovering: boolean; error?: string }
  | { phase: 'review'; vendor: VendorPreset; plan: SetupPlan; discoveryError?: string }
  | { phase: 'done'; vendor: VendorPreset; result: SetupResult; diagnosing: boolean; diagnosis?: { ok: boolean; detail?: string } };

export function QuickSetup({ onOpenModels }: { onOpenModels?: () => void }) {
  const { locale } = useI18n(); const label = (zh: string, en: string) => locale === 'en' ? en : zh;
  const [step, setStep] = useState<Step>({ phase: 'pick' });
  const [apiUrl, setApiUrl] = useState(''); const [apiKey, setApiKey] = useState('');
  const [chatModel, setChatModel] = useState('');
  const [imageModel, setImageModel] = useState(''); const [useImage, setUseImage] = useState(true);
  const [embeddingModel, setEmbeddingModel] = useState(''); const [useEmbedding, setUseEmbedding] = useState(true);
  const [useVideo, setUseVideo] = useState(true); const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const vendorName = (v: VendorPreset) => locale === 'en' ? v.nameEn ?? v.name : v.name;

  const pick = (vendor: VendorPreset) => { request.current += 1; setApiUrl(vendor.apiUrl); setApiKey(''); setError(''); setStep({ phase: 'key', vendor, discovering: false }); };
  const reset = () => { request.current += 1; setError(''); setStep({ phase: 'pick' }); };

  const discover = async (vendor: VendorPreset) => {
    if (vendor.needsKey && !apiKey.trim()) { setStep({ phase: 'key', vendor, discovering: false, error: label('请先填写 API Key。', 'Enter an API key first.') }); return; }
    const id = ++request.current;
    setStep({ phase: 'key', vendor, discovering: true });
    let ids: string[] = []; let discoveryError: string | undefined;
    try {
      const result = await window.electron.discoverServiceModels({ provider: vendor.provider, apiUrl: apiUrl.trim(), apiKey: apiKey.trim(), chatApiMode: vendor.chatApiMode ?? 'auto' });
      if (result?.error) throw new Error(result.error);
      ids = (result?.models ?? []).map(m => (typeof m?.id === 'string' ? m.id.trim() : '')).filter(Boolean);
    } catch (e) { discoveryError = e instanceof Error ? e.message : String(e); }
    if (id !== request.current) return;
    const plan = buildSetupPlan(vendor, ids);
    if (!ids.length && vendor.kind === 'local') {
      setStep({ phase: 'key', vendor, discovering: false, error: discoveryError || label('本机服务没有返回模型，请确认服务已启动并已下载模型。', 'The local service returned no models. Make sure it is running and a model is downloaded.') });
      return;
    }
    setChatModel(plan.chatModel); setImageModel(plan.image?.model ?? ''); setUseImage(Boolean(plan.image));
    setEmbeddingModel(plan.embeddingModel ?? ''); setUseEmbedding(Boolean(plan.embeddingModel)); setUseVideo(Boolean(plan.video));
    setError('');
    setStep({ phase: 'review', vendor, plan, discoveryError });
  };

  const finish = async (vendor: VendorPreset, plan: SetupPlan) => {
    if (!chatModel.trim()) { setError(label('请选择或填写对话模型。', 'Choose or enter a chat model.')); return; }
    let result: SetupResult;
    try {
      const connection = upsertVendorConnection(vendor, apiUrl.trim(), apiKey.trim());
      result = applySetup(vendor, connection, {
        chatModel,
        image: useImage && plan.image ? { ...plan.image, model: imageModel } : undefined,
        embeddingModel: useEmbedding ? embeddingModel : undefined,
        video: useVideo ? plan.video : undefined,
      });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    setError('');
    const id = ++request.current;
    setStep({ phase: 'done', vendor, result, diagnosing: true });
    const model = useModelStore.getState().models.find(m => m.id === result.chatModelId);
    if (!model) { setStep({ phase: 'done', vendor, result, diagnosing: false }); return; }
    let diagnosis: { ok: boolean; detail?: string };
    try {
      const report = await window.electron.diagnoseModel(resolveModelConnection(model), ['chat']);
      const check = report.checks.find(c => c.kind === 'chat');
      diagnosis = { ok: check?.status === 'verified', detail: check?.detail };
    } catch (e) { diagnosis = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
    if (id !== request.current) return;
    setStep({ phase: 'done', vendor, result, diagnosing: false, diagnosis });
  };

  const header = (title: string, hint: string, back = true) => <div className="flex items-center justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-semibold text-stone-800 dark:text-white">{title}</h3><p className={`${HUB_HINT} mt-1`}>{hint}</p></div>{back && <button type="button" className={HUB_SECONDARY} onClick={reset}><FiArrowLeft />{label('返回', 'Back')}</button>}</div>;
  const vendorButton = (vendor: VendorPreset) => <button key={vendor.id} type="button" onClick={() => pick(vendor)} className="min-h-10 rounded-xl border border-stone-200 bg-white px-3 py-2 text-left text-xs font-medium text-stone-700 transition hover:border-primary-500 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:text-primary-300">{vendorName(vendor)}</button>;
  const check = (checked: boolean, onChange: (v: boolean) => void, text: string) => <label className="flex items-center gap-2 text-xs font-medium text-stone-700 dark:text-slate-300"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />{text}</label>;

  if (step.phase === 'pick') return <section className="space-y-4" aria-label={label('快速配置', 'Quick setup')}>
    {header(label('快速配置', 'Quick setup'), label('选择厂商并填写密钥，自动配置对话、生图、向量等模型。', 'Pick a provider and enter a key to configure chat, image and embedding models.'), false)}
    <div className="space-y-2"><p className={HUB_HINT}>{label('云端厂商', 'Cloud providers')}</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{VENDOR_PRESETS.filter(v => v.kind === 'cloud').map(vendorButton)}</div></div>
    <div className="space-y-2"><p className={HUB_HINT}>{label('本机模型', 'Local models')}</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{VENDOR_PRESETS.filter(v => v.kind === 'local').map(vendorButton)}</div></div>
    <p className={HUB_HINT}>{label('其他服务可在「服务连接」中手动添加。', 'Add other services manually under Services.')}</p>
  </section>;

  if (step.phase === 'key') {
    const { vendor, discovering } = step;
    const local = vendor.kind === 'local';
    return <section className="space-y-4" aria-label={label('快速配置', 'Quick setup')}>
      {header(vendorName(vendor), local ? label('确认本机服务地址，读取已安装的模型。', 'Confirm the local address to list installed models.') : label('填写 API Key 后读取可用模型。', 'Enter an API key to list available models.'))}
      <form className={HUB_FORM} onSubmit={e => { e.preventDefault(); void discover(vendor); }} aria-busy={discovering}>
        {!local && <label className={HUB_LABEL}><span>API Key</span><input autoFocus type="password" autoComplete="off" className={HUB_INPUT} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label>}
        {!local && vendor.keyUrl && <p className={HUB_HINT}>{label('获取密钥：', 'Get a key: ')}<span className="break-all">{vendor.keyUrl}</span></p>}
        {local ? <label className={HUB_LABEL}><span>{label('服务地址', 'Service URL')}</span><input className={HUB_INPUT} value={apiUrl} onChange={e => setApiUrl(e.target.value)} /></label>
          : <details><summary className="cursor-pointer text-xs font-medium text-stone-600 dark:text-slate-400">{label('高级：服务地址', 'Advanced: service URL')}</summary><label className={`${HUB_LABEL} mt-2`}><span>{label('服务地址', 'Service URL')}</span><input className={HUB_INPUT} value={apiUrl} onChange={e => setApiUrl(e.target.value)} /></label></details>}
        {local && <details><summary className="cursor-pointer text-xs font-medium text-stone-600 dark:text-slate-400">{label('高级：API Key（可选）', 'Advanced: API key (optional)')}</summary><label className={`${HUB_LABEL} mt-2`}><span>API Key</span><input type="password" autoComplete="off" className={HUB_INPUT} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label></details>}
        {step.error && <p role="alert" className={HUB_ERROR}>{step.error}</p>}
        <button type="submit" disabled={discovering} className={HUB_PRIMARY}>{discovering ? <FiLoader className="animate-spin" /> : <FiZap />}{discovering ? label('正在读取模型…', 'Reading models…') : label('读取模型并配置', 'Read models')}</button>
      </form>
    </section>;
  }

  if (step.phase === 'review') {
    const { vendor, plan } = step;
    return <section className="space-y-4" aria-label={label('快速配置', 'Quick setup')}>
      {header(label(`确认 ${vendorName(vendor)} 配置`, `Confirm ${vendorName(vendor)} setup`), label('已按模型名称自动分类，可调整后完成。', 'Models were grouped by name; adjust before finishing.'))}
      <div className={HUB_FORM}>
        {step.discoveryError && <p role="status" className="text-xs leading-5 text-amber-700 dark:text-amber-300">{label('未能读取模型列表，请手动填写模型名称：', 'Could not list models. Enter model names manually: ')}{step.discoveryError}</p>}
        <label className={HUB_LABEL}><span>{label('对话模型', 'Chat model')}</span>
          {plan.chatCandidates.length
            ? <select className={HUB_INPUT} value={chatModel} onChange={e => setChatModel(e.target.value)}>{plan.chatCandidates.map(id => <option key={id} value={id}>{id}</option>)}</select>
            : <input className={HUB_INPUT} value={chatModel} placeholder={label('服务提供的模型名称', 'Model ID from your provider')} onChange={e => setChatModel(e.target.value)} />}
        </label>
        {plan.image && <div className="space-y-2">{check(useImage, setUseImage, label('同时配置生图', 'Also set up image generation'))}{useImage && <input aria-label={label('生图模型', 'Image model')} className={HUB_INPUT} value={imageModel} onChange={e => setImageModel(e.target.value)} />}</div>}
        {plan.embeddingModel !== undefined && <div className="space-y-2">{check(useEmbedding, setUseEmbedding, label('同时配置向量检索（知识库）', 'Also set up embeddings (knowledge base)'))}{useEmbedding && <input aria-label={label('向量模型', 'Embedding model')} className={HUB_INPUT} value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)} />}</div>}
        {plan.video && check(useVideo, setUseVideo, label(`同时配置视频生成（${plan.video.model}）`, `Also set up video (${plan.video.model})`))}
        {plan.chatCandidates.length > 0 && <p className={HUB_HINT}>{label(`共发现 ${plan.chatCandidates.length} 个对话模型；其余模型可在「服务连接 → 发现模型」中添加。`, `${plan.chatCandidates.length} chat models found; add others under Services → Discover.`)}</p>}
        {error && <p role="alert" className={HUB_ERROR}>{error}</p>}
        <button type="button" className={HUB_PRIMARY} onClick={() => void finish(vendor, plan)}><FiCheckCircle />{label('完成配置', 'Finish setup')}</button>
      </div>
    </section>;
  }

  const { vendor, result, diagnosing, diagnosis } = step;
  const items = [
    result.chatModelId && label('对话模型（已设为当前）', 'Chat model (now active)'),
    result.imageModelId && label('生图模型', 'Image model'),
    result.embedding && label('向量检索', 'Embeddings'),
    result.videoModelId && label('视频生成', 'Video'),
  ].filter(Boolean) as string[];
  return <section className="space-y-4" aria-label={label('快速配置', 'Quick setup')}>
    {header(label(`${vendorName(vendor)} 已配置`, `${vendorName(vendor)} is ready`), label('密钥保存在服务连接中，各项能力共用。', 'The key is stored once in the service connection and shared.'))}
    <div className={HUB_CARD}>
      <div className="flex flex-wrap gap-1.5">{items.map(text => <span key={text} className={HUB_BADGE}>{text}</span>)}</div>
      <p role="status" className="mt-3 flex items-center gap-2 text-xs">
        {diagnosing ? <><FiLoader className="animate-spin" />{label('正在测试对话…', 'Testing chat…')}</>
          : diagnosis ? <span className={diagnosis.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300'}>{diagnosis.ok ? label('对话测试通过', 'Chat test passed') : label(`对话测试未通过：${diagnosis.detail ?? ''}`, `Chat test failed: ${diagnosis.detail ?? ''}`)}</span>
          : null}
      </p>
      {result.chatModelId && classifyModelId(useModelStore.getState().models.find(m => m.id === result.chatModelId)?.modelName ?? '') !== 'chat' && <p className={`${HUB_HINT} mt-2`}>{label('该名称看起来不是对话模型，如测试失败请更换。', 'This name does not look like a chat model; change it if the test fails.')}</p>}
    </div>
    <div className="flex flex-wrap gap-2"><button type="button" className={HUB_PRIMARY} onClick={reset}>{label('再配置一个厂商', 'Set up another provider')}</button>{onOpenModels && <button type="button" className={HUB_SECONDARY} onClick={onOpenModels}>{label('查看模型', 'View models')}</button>}</div>
  </section>;
}
