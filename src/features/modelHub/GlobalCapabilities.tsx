import { useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useConnectionStore } from '../../store/connectionStore';
import { useKnowledgeStore } from '../../store/knowledgeStore';
import { IosSwitch } from '../../components/IosSwitch';
import { WebSearchSection } from '../../components/settings/WebSearchSection';
import { VideoModelsSection } from '../connections/VideoModelsSection';
import { VoiceQuickSettings } from '../voiceQuick/VoiceQuickSettings';
import { HUB_HINT, HUB_INPUT, HUB_LABEL } from './styles';

type Capability = 'voice' | 'video' | 'embedding' | 'web';

function EmbeddingCapability() {
  const { locale } = useI18n(); const label = (zh: string, en: string) => locale === 'en' ? en : zh;
  const allConnections = useConnectionStore(s => s.connections);
  /** Anthropic / Gemini 不提供 OpenAI 兼容或 Ollama 嵌入接口 */
  const connections = allConnections.filter(c => c.provider !== 'claude' && c.provider !== 'gemini');
  const { vectorRagEnabled, setVectorRagEnabled, embeddingProvider, setEmbeddingProvider, embeddingConnectionId, setEmbeddingConnection, embeddingModel, setEmbeddingModel } = useKnowledgeStore();
  const linked = connections.find(c => c.id === embeddingConnectionId);
  const source = embeddingProvider === 'off' ? 'off' : linked ? linked.id : 'custom';
  return <section className="space-y-3" aria-label={label('向量检索', 'Embeddings')}>
    <h3 className="text-sm font-semibold text-stone-800 dark:text-white">{label('向量检索', 'Embeddings')}</h3>
    <p className={HUB_HINT}>{label('用于知识库与工作区检索。选择已有服务连接即可复用其地址和密钥。', 'Used by the knowledge base and workspace search. Pick a service connection to reuse its URL and key.')}</p>
    <div className="flex items-center justify-between gap-3"><span className="text-xs text-stone-700 dark:text-slate-300">{label('发送前检索工作区资料', 'Search workspace before sending')}</span><IosSwitch checked={vectorRagEnabled} aria-label={label('发送前检索工作区资料', 'Search workspace before sending')} onChange={setVectorRagEnabled} /></div>
    <label className={HUB_LABEL}><span>{label('嵌入服务', 'Embedding service')}</span>
      <select className={HUB_INPUT} value={source} onChange={e => {
        const value = e.target.value;
        if (value === 'off') { setEmbeddingConnection(null); setEmbeddingProvider('off'); }
        else if (value === 'custom') { setEmbeddingConnection(null); if (embeddingProvider === 'off') setEmbeddingProvider('openai'); }
        else setEmbeddingConnection(value);
      }}>
        <option value="off">{label('关闭', 'Off')}</option>
        {connections.map(c => <option key={c.id} value={c.id}>{label(`复用：${c.name}`, `Reuse: ${c.name}`)}</option>)}
        <option value="custom">{label('独立配置（在知识库中设置）', 'Independent (set in Knowledge)')}</option>
      </select>
    </label>
    {source !== 'off' && <label className={HUB_LABEL}><span>{label('向量模型', 'Embedding model')}</span><input className={HUB_INPUT} value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)} /></label>}
  </section>;
}

export function GlobalCapabilities({ systemTtsAvailable, microphoneMissing }: { systemTtsAvailable: boolean | null; microphoneMissing: boolean }) {
  const { t, locale } = useI18n(); const label = (zh: string, en: string) => locale === 'en' ? en : zh;
  const [active, setActive] = useState<Capability>('voice');
  const items: { id: Capability; title: string }[] = [
    { id: 'voice', title: label('语音与回答', 'Voice & reply') },
    { id: 'video', title: label('视频生成', 'Video') },
    { id: 'embedding', title: label('向量检索', 'Embeddings') },
    { id: 'web', title: label('联网搜索', 'Web search') },
  ];
  return <div className="space-y-4">
    <p className={HUB_HINT}>{label('这些能力对所有对话生效，与当前选用的对话模型无关。', 'These capabilities apply to every chat, independent of the active chat model.')}</p>
    <div role="group" aria-label={label('全局能力', 'Global capabilities')} className="flex flex-wrap gap-1.5">
      {items.map(item => <button key={item.id} type="button" aria-pressed={active === item.id} onClick={() => setActive(item.id)} className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${active === item.id ? 'bg-primary-500/10 text-primary-700 dark:text-primary-300' : 'text-stone-500 hover:bg-stone-200/60 dark:text-slate-400 dark:hover:bg-slate-800'}`}>{item.title}</button>)}
    </div>
    <div hidden={active !== 'voice'}><VoiceQuickSettings systemTtsAvailable={systemTtsAvailable} microphoneMissing={microphoneMissing} /></div>
    <div hidden={active !== 'video'}><VideoModelsSection embedded cardShell="" /></div>
    <div hidden={active !== 'embedding'}><EmbeddingCapability /></div>
    <div hidden={active !== 'web'}><WebSearchSection embedded cardShell="" t={t} /></div>
  </div>;
}
