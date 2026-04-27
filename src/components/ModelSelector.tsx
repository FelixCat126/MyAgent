import React from 'react';
import { useModelStore } from '../store/modelStore';
import { ModelConfig } from '../types';
import { useI18n } from '../hooks/useI18n';

export interface ModelSelectorProps {
  /** 嵌入输入条右侧的极简样式 */
  compact?: boolean;
  className?: string;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ compact, className }) => {
  const { t } = useI18n();
  const { models, activeModelId, setActiveModel, getActiveModel } = useModelStore();
  const activeModel = getActiveModel();

  const selectClass = compact
    ? 'h-7 max-w-[5.75rem] cursor-pointer rounded-md border border-stone-400/40 bg-stone-200/80 py-0 pl-1 pr-0.5 text-[10px] font-medium leading-none text-stone-700 transition-colors hover:bg-stone-300/80 focus:outline-none focus:ring-1 focus:ring-primary-500/40 dark:border-slate-600 dark:bg-slate-900/80 dark:text-slate-200 dark:hover:bg-slate-800 sm:max-w-[6.5rem]'
    : 'w-full min-w-0 max-w-full cursor-pointer rounded-lg border border-stone-400/35 bg-stone-100/90 px-3 py-2 text-xs font-medium text-stone-800 transition-colors hover:bg-stone-200/90 focus:outline-none focus:ring-2 focus:ring-primary-500/40 dark:border-slate-600 dark:bg-slate-800/90 dark:text-slate-200 dark:hover:bg-slate-700/90';

  return (
    <div
      className={`flex min-w-0 items-center ${compact ? 'shrink-0 justify-end' : 'w-full'} ${className ?? ''}`}
      title={activeModel?.name || t('modelSelect.placeholder')}
    >
      <select
        value={activeModelId || ''}
        onChange={(e) => setActiveModel(e.target.value)}
        className={selectClass}
        style={{ WebkitAppearance: 'none', MozAppearance: 'none', appearance: 'none', textOverflow: 'ellipsis' }}
      >
        {models.length === 0 ? (
          <option value="">{t('modelSelect.empty')}</option>
        ) : (
          models.map((model: ModelConfig) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))
        )}
      </select>
    </div>
  );
};

export default ModelSelector;
