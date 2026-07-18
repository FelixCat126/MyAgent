/**
 * 知识库设置区：向量 RAG 开关、embedding 来源（off / ollama / openai）、
 * 高级参数（topK / maxInject / API Key / URL / 模型 / 火山多模态）、
 * 索引状态展示与触发重新索引按钮。
 *
 * 抽离自 SettingsPanel.tsx（aria-labelledby="settings-knowledge-heading" 的 <section>），
 * 行为与拆分前完全一致。
 *
 * 状态拆分原则：
 *  - store 派生量（vectorRagEnabled / embeddingProvider / rootPath 等）→ 本组件自己调对应 store hook
 *  - 折叠态、索引态（knowledgeBlockExpanded / indexBusy / indexMeta）→ 本组件内部 useState
 *  - 刷新索引状态（refreshIndexStatus）→ 本组件内部 useCallback + 初始化 useEffect
 */

import React, { useState, useEffect, useCallback } from 'react';
import { FiLayers, FiChevronUp, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { IosSwitch } from '../IosSwitch';
import { useKnowledgeStore } from '../../store/knowledgeStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { showError, showInfo, showWarning } from '../../store/errorStore';
import { formatDateTime } from '../../utils/formatDateTime';
import { useSettingStore } from '../../store/settingStore';

export interface KnowledgeSectionProps {
  /** 卡片外壳 CSS（父组件常量） */
  cardShell: string;
  /** i18n 翻译函数 */
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const KnowledgeSection: React.FC<KnowledgeSectionProps> = ({ cardShell, t }) => {
  // store 派生量本组件自己消费（仅读 rootPath；写入由 AppSection 负责）
  const { rootPath } = useWorkspaceStore();
  const {
    vectorRagEnabled,
    setVectorRagEnabled,
    vectorTopK,
    setVectorTopK,
    ragMaxInjectChars,
    setRagMaxInjectChars,
    embeddingProvider,
    setEmbeddingProvider,
    embeddingApiUrl,
    setEmbeddingApiUrl,
    embeddingApiKey,
    setEmbeddingApiKey,
    embeddingModel,
    setEmbeddingModel,
    embeddingVolcMultimodal,
    setEmbeddingVolcMultimodal,
    getEmbedConfigForIpc,
  } = useKnowledgeStore();

  // 本组件内部状态：折叠态 + 索引状态
  const [knowledgeBlockExpanded, setKnowledgeBlockExpanded] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexMeta, setIndexMeta] = useState<{
    chunkCount: number;
    root: string | null;
    model: string | null;
    updatedAt: number;
  } | null>(null);

  const refreshIndexStatus = useCallback(async () => {
    try {
      const s = await window.electron.knowledgeGetIndexStatus();
      if (s?.ok) {
        setIndexMeta({
          chunkCount: s.chunkCount,
          root: s.root,
          model: s.model,
          updatedAt: s.updatedAt,
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshIndexStatus();
  }, [refreshIndexStatus]);

  /** 索引进行中时禁用按钮（原父组件 knowledgeIndexLocked 派生量） */
  const knowledgeIndexLocked = indexBusy;

  return (
    <section
      className={`${cardShell} mt-2 shrink-0`}
      aria-labelledby="settings-knowledge-heading"
    >
      <div className="flex items-center justify-between gap-2 border-b border-stone-300/38 px-3 py-2.5 dark:border-white/10">
        <div className="flex min-w-0 items-center gap-2">
          <FiLayers className="shrink-0 text-primary-600 dark:text-primary-400" size={16} aria-hidden />
          <h2 id="settings-knowledge-heading" className="text-sm font-semibold text-stone-800 dark:text-white">
            {t('settings.knowledge')}
          </h2>
        </div>
        <button
          type="button"
          aria-expanded={knowledgeBlockExpanded}
          onClick={() => setKnowledgeBlockExpanded((v) => !v)}
          className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-200/65 hover:text-stone-800 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {knowledgeBlockExpanded ? <FiChevronUp size={18} /> : <FiChevronDown size={18} />}
        </button>
      </div>
      {knowledgeBlockExpanded && (
        <div className="space-y-2.5 px-3 pb-3 pt-3">
          <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
            {t('settings.knowledgeDescShort')}
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-stone-700 dark:text-slate-300">{t('settings.ragEnableShort')}</span>
            <IosSwitch
              checked={vectorRagEnabled}
              aria-label={t('settings.ragEnableShort')}
              onChange={setVectorRagEnabled}
            />
          </div>
          <p className="text-[10px] font-medium text-stone-600 dark:text-slate-400">
            {t('settings.knowledgePickSource')}
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                { id: 'off' as const, label: t('settings.knowledgeModeOff') },
                { id: 'ollama' as const, label: t('settings.knowledgeModeLocal') },
                { id: 'openai' as const, label: t('settings.knowledgeModeCloud') },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setEmbeddingProvider(opt.id)}
                className={
                  'rounded-lg border px-1.5 py-2 text-center text-[11px] font-medium leading-tight transition-colors ' +
                  (embeddingProvider === opt.id
                    ? 'border-primary-500/80 bg-primary-500/12 text-primary-800 shadow-sm ring-1 ring-primary-500/15 dark:border-primary-400/55 dark:bg-primary-500/18 dark:text-primary-100 dark:ring-primary-400/10'
                    : 'border-stone-300/40 bg-stone-100/85 text-stone-700 hover:border-stone-400/50 hover:bg-stone-200/60 dark:border-white/12 dark:bg-slate-800/80 dark:text-slate-300 dark:hover:border-white/18 dark:hover:bg-slate-700/70')
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
          {embeddingProvider === 'off' && (
            <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
              {t('settings.knowledgeHintOff')}
            </p>
          )}
          {embeddingProvider === 'ollama' && (
            <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
              {t('settings.knowledgeHintLocal')}
            </p>
          )}
          {embeddingProvider === 'openai' && (
            <>
              <p className="text-[10px] leading-relaxed text-stone-500 dark:text-slate-500">
                {t('settings.knowledgeHintCloud')}
              </p>
              <div>
                <label className="mb-0.5 block text-[10px] font-medium text-stone-600 dark:text-gray-400">
                  {t('settings.cloudApiKey')}
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  value={embeddingApiKey}
                  onChange={(e) => setEmbeddingApiKey(e.target.value)}
                  placeholder="sk-…"
                  className="w-full rounded-md border border-stone-400/25 bg-stone-100/90 px-2 py-1.5 font-mono text-xs text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-slate-700 dark:text-white"
                />
              </div>
            </>
          )}
          <details className="group/details rounded-lg border border-stone-300/38 bg-stone-100/70 px-2 py-1.5 dark:border-white/10 dark:bg-slate-900/55">
            <summary className="flex cursor-pointer items-center gap-1 select-none text-[10px] font-medium text-stone-600 dark:text-slate-400 list-none [&::-webkit-details-marker]:hidden">
              <FiChevronRight
                size={12}
                className="shrink-0 text-stone-400 transition-transform duration-200 group-open/details:rotate-90 dark:text-slate-500"
                aria-hidden
              />
              {t('settings.advanced')}
            </summary>
            <div className="mt-2 space-y-2 border-t border-stone-300/35 pt-2 dark:border-white/8">
              {embeddingProvider !== 'off' && (
                <>
                  <div>
                    <label className="mb-0.5 block text-[9px] font-medium text-stone-500 dark:text-slate-500">
                      {t('settings.embedUrl')}
                    </label>
                    <input
                      type="text"
                      value={embeddingApiUrl}
                      onChange={(e) => setEmbeddingApiUrl(e.target.value)}
                      placeholder={
                        embeddingProvider === 'ollama'
                          ? t('settings.embedUrlPhOllama')
                          : t('settings.embedUrlPhOpenAI')
                      }
                      className="w-full rounded-md border border-stone-400/30 bg-stone-100/95 px-2 py-1 font-mono text-[10px] text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500/70 dark:border-gray-600 dark:bg-slate-800/95 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[9px] font-medium text-stone-500 dark:text-slate-500">
                      {t('settings.embedModel')}
                    </label>
                    <input
                      type="text"
                      value={embeddingModel}
                      onChange={(e) => setEmbeddingModel(e.target.value)}
                      className="w-full rounded-md border border-stone-400/30 bg-stone-100/95 px-2 py-1 font-mono text-[10px] text-stone-900 focus:outline-none focus:ring-1 focus:ring-primary-500/70 dark:border-gray-600 dark:bg-slate-800/95 dark:text-slate-100"
                    />
                  </div>
                  {embeddingProvider === 'openai' && (
                    <div className="rounded-md border border-stone-300/40 bg-stone-50/90 px-2 py-1.5 dark:border-white/10 dark:bg-slate-800/50">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 text-[9px] leading-snug text-stone-700 dark:text-slate-300">
                          {t('settings.embedVolcMultimodal')}
                        </span>
                        <IosSwitch
                          checked={embeddingVolcMultimodal}
                          aria-label={t('settings.embedVolcMultimodal')}
                          onChange={setEmbeddingVolcMultimodal}
                        />
                      </div>
                      <p className="mt-1 text-[9px] leading-relaxed text-stone-500 dark:text-slate-500">
                        {t('settings.embedVolcMultimodalHint')}
                      </p>
                    </div>
                  )}
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <div className="min-w-[5rem] flex-1">
                  <label className="mb-0.5 block text-[9px] font-medium text-stone-500 dark:text-slate-500">
                    {t('settings.ragTopK')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={vectorTopK}
                    onChange={(e) => setVectorTopK(parseInt(e.target.value, 10) || 5)}
                    className="w-full rounded border border-stone-400/30 bg-stone-100/95 px-1.5 py-0.5 text-[10px] text-stone-900 dark:border-gray-600 dark:bg-slate-800/95 dark:text-slate-100"
                  />
                </div>
                <div className="min-w-[6rem] flex-[1.2]">
                  <label className="mb-0.5 block text-[9px] font-medium text-stone-500 dark:text-slate-500">
                    {t('settings.ragMaxInject')}
                  </label>
                  <input
                    type="number"
                    min={1000}
                    max={30000}
                    step={500}
                    value={ragMaxInjectChars}
                    onChange={(e) => setRagMaxInjectChars(parseInt(e.target.value, 10) || 8000)}
                    className="w-full rounded border border-stone-400/30 bg-stone-100/95 px-1.5 py-0.5 text-[10px] text-stone-900 dark:border-gray-600 dark:bg-slate-800/95 dark:text-slate-100"
                  />
                </div>
              </div>
            </div>
          </details>
          <p className="text-[10px] text-stone-500 dark:text-slate-500">
            {indexMeta && indexMeta.chunkCount > 0
              ? t('settings.indexStatus', {
                  chunks: indexMeta.chunkCount,
                  time:
                    indexMeta.updatedAt > 0
                      ? formatDateTime(indexMeta.updatedAt, useSettingStore.getState().locale)
                      : '—',
                })
              : t('settings.indexNone')}
          </p>
          <button
            type="button"
            disabled={knowledgeIndexLocked}
            onClick={async () => {
              const root = rootPath.trim();
              if (!root) {
                showWarning('settings.indexRootMissing');
                return;
              }
              const embed = getEmbedConfigForIpc();
              if (!embed) {
                showWarning('settings.indexEmbedOff');
                return;
              }
              setIndexBusy(true);
              try {
                const r = await window.electron.knowledgeIndexWorkspace({ root, embed });
                if (!r.ok) {
                  showError('common.operationFailed', { detail: r.error || 'index failed' });
                  return;
                }
                if (r.truncated) {
                  showInfo('settings.indexTruncated');
                }
                await refreshIndexStatus();
              } finally {
                setIndexBusy(false);
              }
            }}
            className="w-full rounded-lg bg-primary-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {indexBusy ? t('settings.reindexing') : t('settings.reindex')}
          </button>
        </div>
      )}
    </section>
  );
};

export default KnowledgeSection;
