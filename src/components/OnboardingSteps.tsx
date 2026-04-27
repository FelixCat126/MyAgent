import React, { Fragment, useCallback, useMemo, useState } from 'react';
import { FiCheck } from 'react-icons/fi';
import { useI18n, tStatic } from '../hooks/useI18n';
import type { Locale } from '../i18n/types';

const STORAGE_KEY = 'myagent-onboarding-dismissed';

export interface OnboardingStep {
  id: string;
  label: string;
  detail?: string;
}

/** 与默认引导步骤一致，可在测试或调用方用 `tStatic` 预生成 */
export function getInitialSteps(locale: Locale): OnboardingStep[] {
  return [
    { id: 'welcome', label: tStatic(locale, 'onboarding.welcome'), detail: tStatic(locale, 'onboarding.welcomeDesc') },
    { id: 'session', label: tStatic(locale, 'onboarding.session'), detail: tStatic(locale, 'onboarding.sessionDesc') },
    { id: 'model', label: tStatic(locale, 'onboarding.model'), detail: tStatic(locale, 'onboarding.modelDesc') },
    { id: 'send', label: tStatic(locale, 'onboarding.send'), detail: tStatic(locale, 'onboarding.sendDesc') },
  ];
}

interface OnboardingStepsProps {
  steps?: OnboardingStep[];
}

const OnboardingSteps: React.FC<OnboardingStepsProps> = ({ steps: stepsProp }) => {
  const { t, locale } = useI18n();
  const builtInSteps = useMemo(() => getInitialSteps(locale), [locale]);
  const steps = stepsProp ?? builtInSteps;
  const [visible, setVisible] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.electron?.persistGetSync && window.electron.persistSetSync) {
        let v = window.electron.persistGetSync(STORAGE_KEY);
        if (v == null) {
          const ls = localStorage.getItem(STORAGE_KEY);
          if (ls) {
            window.electron.persistSetSync(STORAGE_KEY, ls);
            localStorage.removeItem(STORAGE_KEY);
            v = ls;
          }
        }
        return !v;
      }
      return !localStorage.getItem(STORAGE_KEY);
    } catch {
      return true;
    }
  });
  const [activeIndex, setActiveIndex] = useState(0);

  const dismiss = useCallback(() => {
    try {
      if (window.electron?.persistSetSync) {
        window.electron.persistSetSync(STORAGE_KEY, '1');
      } else {
        localStorage.setItem(STORAGE_KEY, '1');
      }
    } catch {
      /* ignore */
    }
    setVisible(false);
  }, []);

  if (!visible) return null;

  const current = steps[activeIndex];
  const isFirst = activeIndex === 0;
  const isLast = activeIndex === steps.length - 1;

  const goPrev = () => {
    if (!isFirst) setActiveIndex((i) => i - 1);
  };

  const goNext = () => {
    if (isLast) {
      dismiss();
    } else {
      setActiveIndex((i) => i + 1);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-stone-900/45 backdrop-blur-md dark:bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-step-title"
    >
      {/* 窗口顶部：横向 1-2-3-4 */}
      <header className="shrink-0 border-b border-stone-400/25 bg-[#ebe8e2]/95 px-3 pb-4 pt-5 dark:border-white/10 dark:bg-[#1c1c22]/95 sm:px-6">
        <p className="mb-3 text-center text-xs font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-400">
          {t('onboarding.quickStart')}
        </p>
        <div className="mx-auto flex max-w-3xl items-center justify-center">
          {steps.map((step, index) => {
            const done = index < activeIndex;
            const active = index === activeIndex;
            const shortLabel = step.label.split(/[（(]/)[0];
            return (
              <Fragment key={step.id}>
                <div className="flex flex-col items-center gap-1">
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors ${
                      done
                        ? 'border-primary-500 bg-primary-500 text-white'
                        : active
                          ? 'border-primary-500 bg-primary-500 text-white ring-2 ring-primary-500/35'
                          : 'border-stone-300 bg-stone-100 text-stone-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400'
                    }`}
                    aria-current={active ? 'step' : undefined}
                    aria-label={`${t('onboarding.stepN', { n: index + 1 })}${active ? t('onboarding.currentStep') : ''}`}
                  >
                    {done ? <FiCheck className="h-4 w-4" strokeWidth={2.5} /> : index + 1}
                  </div>
                  <span
                    className={`max-w-[4.5rem] truncate text-center text-[10px] font-medium leading-tight sm:max-w-[6rem] ${
                      active ? 'text-primary-600 dark:text-primary-400' : 'text-stone-500 dark:text-slate-500'
                    }`}
                  >
                    {shortLabel}
                  </span>
                </div>
                {index < steps.length - 1 && (
                  <div
                    className={`mx-1 h-0.5 w-5 shrink-0 sm:mx-2 sm:w-14 ${
                      activeIndex > index ? 'bg-primary-500' : 'bg-stone-300 dark:bg-slate-600'
                    }`}
                    aria-hidden
                  />
                )}
              </Fragment>
            );
          })}
        </div>
      </header>

      {/* 中部：当前步骤说明（随上一步/下一步切换） */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#f4f2ed] dark:bg-[#18181c]">
        <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center px-5 py-8 sm:px-8 sm:py-12">
          <h2
            id="onboarding-step-title"
            className="text-xl font-semibold text-stone-900 dark:text-white sm:text-2xl"
          >
            {current.label}
          </h2>
          {current.detail ? (
            <p className="mt-4 text-base leading-relaxed text-stone-600 dark:text-slate-400 sm:text-lg">
              {current.detail}
            </p>
          ) : null}
        </div>
      </div>

      {/* 窗口底部：跳过 + 上一步 / 下一步 */}
      <footer className="shrink-0 border-t border-stone-400/25 bg-[#ebe8e2]/95 px-4 py-4 dark:border-white/10 dark:bg-[#1c1c22]/95 sm:px-8">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={dismiss}
            className="text-sm font-medium text-stone-500 hover:text-stone-800 dark:text-slate-400 dark:hover:text-white"
          >
            {t('onboarding.skip')}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goPrev}
              disabled={isFirst}
              className="rounded-xl border border-stone-300 bg-stone-100/90 px-4 py-2.5 text-sm font-medium text-stone-700 transition hover:bg-stone-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              {t('onboarding.prev')}
            </button>
            <button
              type="button"
              onClick={goNext}
              className="rounded-xl bg-gradient-to-r from-primary-500 to-teal-500 px-5 py-2.5 text-sm font-medium text-white shadow-md shadow-primary-500/25 transition hover:from-primary-600 hover:to-teal-600"
            >
              {isLast ? t('onboarding.done') : t('onboarding.next')}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default OnboardingSteps;
