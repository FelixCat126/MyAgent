import React, { useEffect } from 'react';
import {
  useErrorStore,
  dismissError,
  type ErrorLevel,
} from '../store/errorStore';
import { useI18n } from '../hooks/useI18n';
import { FiAlertCircle, FiAlertTriangle, FiCheckCircle, FiInfo, FiX } from 'react-icons/fi';

const LEVEL_STYLE: Record<ErrorLevel, { wrap: string; icon: React.ReactNode }> = {
  error: {
    wrap: 'border-red-300/70 bg-red-50/95 text-red-800 dark:border-red-500/40 dark:bg-red-950/85 dark:text-red-100',
    icon: <FiAlertCircle className="shrink-0" aria-hidden size={16} />,
  },
  warning: {
    wrap: 'border-amber-300/70 bg-amber-50/95 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/85 dark:text-amber-100',
    icon: <FiAlertTriangle className="shrink-0" aria-hidden size={16} />,
  },
  success: {
    wrap: 'border-emerald-300/70 bg-emerald-50/95 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/85 dark:text-emerald-100',
    icon: <FiCheckCircle className="shrink-0" aria-hidden size={16} />,
  },
  info: {
    wrap: 'border-sky-300/70 bg-sky-50/95 text-sky-800 dark:border-sky-500/40 dark:bg-sky-950/85 dark:text-sky-100',
    icon: <FiInfo className="shrink-0" aria-hidden size={16} />,
  },
};

const ErrorToast: React.FC = () => {
  const items = useErrorStore((s) => s.items);
  const { t } = useI18n();

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-3 z-[1000] flex flex-col items-center gap-2 px-3"
      role="region"
      aria-live="polite"
      aria-label={t('common.notifications')}
    >
      {items.map((item) => (
        <ErrorToastItem
          key={item.id}
          id={item.id}
          level={item.level}
          message={t(item.key, item.params)}
        />
      ))}
    </div>
  );
};

const ErrorToastItem: React.FC<{ id: number; level: ErrorLevel; message: string }> = ({
  id,
  level,
  message,
}) => {
  const style = LEVEL_STYLE[level];

  useEffect(() => {
    const state = useErrorStore.getState();
    const item = state.items.find((it) => it.id === id);
    if (!item || item.durationMs <= 0) return;
    const timer = setTimeout(() => dismissError(id), item.durationMs);
    return () => clearTimeout(timer);
  }, [id]);

  return (
    <div
      role={level === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto flex max-w-[36rem] items-start gap-2 rounded-xl border px-3 py-2 text-xs shadow-lg backdrop-blur-sm transition-all ${style.wrap}`}
    >
      {style.icon}
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <button
        type="button"
        onClick={() => dismissError(id)}
        className="-mr-1 shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-current"
        aria-label="Dismiss"
      >
        <FiX size={14} aria-hidden />
      </button>
    </div>
  );
};

export default ErrorToast;
