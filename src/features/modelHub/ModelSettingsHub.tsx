import { useId, useRef, useState } from 'react';
import { FiCpu } from 'react-icons/fi';
import { useI18n } from '../../hooks/useI18n';
import { useModelStore } from '../../store/modelStore';
import { useConnectionStore } from '../../store/connectionStore';
import { ModelsSection } from '../../components/settings/ModelsSection';
import { ConnectionsSection } from '../connections/ConnectionsSection';
import { VideoModelsSection } from '../connections/VideoModelsSection';
import { VoiceQuickSettings } from '../voiceQuick/VoiceQuickSettings';
import './ModelSettingsHub.css';
type HubTab = 'models' | 'video' | 'connections' | 'voice';
export function ModelSettingsHub({ cardShell, systemTtsAvailable, microphoneMissing }: { cardShell: string; systemTtsAvailable: boolean | null; microphoneMissing: boolean }) {
  const { t, locale } = useI18n(); const en = locale === 'en'; const label = (zh: string, english: string) => en ? english : zh;
  const [tab, setTab] = useState<HubTab>('models'); const id = useId(); const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const models = useModelStore(s => s.models); const services = useConnectionStore(s => s.connections); const organization = useConnectionStore(s => s.organizationSummary);
  const modelCount = models.filter(m => m.isChatModel !== false || m.isImageGenerator).length; const videoCount = models.filter(m => m.isVideoGenerator && m.videoGeneratorConfig).length;
  const tabs: { id: HubTab; title: string; count: string }[] = [{ id: 'models', title: label('对话与图片', 'Chat & images'), count: String(modelCount) }, { id: 'video', title: label('视频模型', 'Video'), count: String(videoCount) }, { id: 'connections', title: label('服务连接', 'Services'), count: String(services.length) }, { id: 'voice', title: label('语音与回答', 'Voice & reply'), count: '' }];
  return <section lang={locale} className={`${cardShell} model-settings-hub min-w-0 overflow-hidden`} aria-labelledby={`${id}-heading`}>
    <header className="flex items-start gap-3 px-4 pb-3 pt-4"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-600 dark:text-primary-300"><FiCpu size={18} /></span><div className="min-w-0 flex-1"><h2 id={`${id}-heading`} className="text-sm font-semibold text-stone-800 dark:text-white">{t('settings.modelConfig')}</h2><p className="mt-1 text-xs leading-5 text-stone-500 dark:text-slate-400">{label(`${modelCount} 个对话 / 图片模型 · ${videoCount} 个视频模型 · ${services.length} 个服务`, `${modelCount} chat / image models · ${videoCount} video models · ${services.length} services`)}</p></div></header>
    {organization.status === 'ready' && organization.organizedModels > 0 && <p role="status" className="mx-4 mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] leading-5 text-emerald-700 dark:bg-emerald-950/35 dark:text-emerald-300">{label('原有服务配置已自动整理，现有配置已保留。', 'Existing service settings organized; your configuration is retained.')}</p>}
    {organization.status === 'pending' && models.length > 0 && <p role="status" className="mx-4 mb-3 text-[11px] leading-5 text-stone-500 dark:text-slate-400">{label('正在整理原有服务配置…', 'Organizing existing service settings…')}</p>}
    {organization.status === 'failed' && <p role="status" className="mx-4 mb-3 text-[11px] leading-5 text-amber-700 dark:text-amber-300">{label('自动整理暂未完成，现有模型配置仍可使用。', 'Organization is incomplete; existing model settings remain usable.')}</p>}
    <div role="tablist" aria-label={label('模型配置分类', 'Model settings categories')} className="model-hub-tabs mx-3 rounded-xl bg-stone-100 p-1 dark:bg-slate-950/80">
      {tabs.map((item, index) => <button ref={element => { buttons.current[index] = element; }} key={item.id} id={`${id}-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`${id}-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => { let next = index; if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % tabs.length; else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index + tabs.length - 1) % tabs.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = tabs.length - 1; else return; event.preventDefault(); setTab(tabs[next].id); buttons.current[next]?.focus(); }} className={`flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${tab === item.id ? 'bg-white text-primary-700 shadow-sm dark:bg-slate-800 dark:text-primary-300' : 'text-stone-500 hover:bg-white/60 hover:text-stone-800 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200'}`}><span className="truncate">{item.title}</span>{item.count && <span aria-hidden className="rounded bg-stone-200/70 px-1 text-[10px] dark:bg-slate-700">{item.count}</span>}</button>)}
    </div>
    <div className="px-3 pb-3 pt-4">
      <div role="tabpanel" id={`${id}-panel-models`} aria-labelledby={`${id}-tab-models`} hidden={tab !== 'models'}><ModelsSection embedded cardShell="" t={t} onOpenConnections={() => { setTab('connections'); buttons.current[2]?.focus(); }} /></div>
      <div role="tabpanel" id={`${id}-panel-video`} aria-labelledby={`${id}-tab-video`} hidden={tab !== 'video'}><VideoModelsSection embedded cardShell="" /></div>
      <div role="tabpanel" id={`${id}-panel-connections`} aria-labelledby={`${id}-tab-connections`} hidden={tab !== 'connections'}><ConnectionsSection embedded cardShell="" /></div>
      <div role="tabpanel" id={`${id}-panel-voice`} aria-labelledby={`${id}-tab-voice`} hidden={tab !== 'voice'}><VoiceQuickSettings systemTtsAvailable={systemTtsAvailable} microphoneMissing={microphoneMissing} /></div>
    </div>
  </section>;
}
