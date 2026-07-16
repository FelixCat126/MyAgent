/**
 * 助手思考过程的折叠面板。
 *
 * 流式输出时自动展开并跟随滚动；结束后自动折叠但仍可手动展开查看。
 *
 * 抽离自 MessageItem.tsx（第 225-299 行），行为与拆分前完全一致。
 */

import React, { useEffect, useRef, useState } from 'react';
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';

export interface AssistantReasoningCollapsibleProps {
  reasoning: string;
  isThoughtStreaming: boolean;
  t: (key: string) => string;
}

export const AssistantReasoningCollapsible: React.FC<AssistantReasoningCollapsibleProps> = (props) => {
  const { reasoning, isThoughtStreaming, t } = props;
  /** 流式输出时展开；结束后自动折叠，仍可手动展开查看 */
  const [expanded, setExpanded] = useState(isThoughtStreaming);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFollowRaf = useRef(0);

  useEffect(() => {
    setExpanded(isThoughtStreaming);
  }, [isThoughtStreaming]);

  const showBody = isThoughtStreaming || expanded;

  const handleToggle = () => {
    if (isThoughtStreaming) return;
    setExpanded((v) => !v);
  };

  useEffect(() => {
    if (!showBody) return;
    if (scrollFollowRaf.current !== 0) window.cancelAnimationFrame(scrollFollowRaf.current);
    scrollFollowRaf.current = window.requestAnimationFrame(() => {
      scrollFollowRaf.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => {
      if (scrollFollowRaf.current !== 0) window.cancelAnimationFrame(scrollFollowRaf.current);
    };
  }, [reasoning, showBody]);

  return (
    <div
      className={
        (showBody ? 'mb-2 border-b border-stone-200/80 pb-2.5 ' : 'mb-1.5 ') +
        'dark:border-slate-600/45 text-stone-700 dark:text-slate-300'
      }
    >
      <button
        type="button"
        disabled={isThoughtStreaming}
        onClick={handleToggle}
        className={`flex w-full items-center gap-1.5 -mx-0.5 px-0.5 py-1 text-left text-[11px] font-medium text-stone-600 dark:text-slate-400 ${
          isThoughtStreaming ? 'cursor-default' : 'cursor-pointer hover:text-stone-800 dark:hover:text-slate-200'
        }`}
        aria-expanded={showBody}
      >
        {showBody ? (
          <FiChevronDown size={14} className="shrink-0 opacity-80" aria-hidden />
        ) : (
          <FiChevronRight size={14} className="shrink-0 opacity-80" aria-hidden />
        )}
        <span className="min-w-0 flex-1">{t('chat.reasoningSection')}</span>
        <span className="shrink-0 text-[10px] font-normal opacity-75 tabular-nums">
          {isThoughtStreaming ? t('chat.reasoningStreaming') : showBody ? t('chat.reasoningCollapse') : t('chat.reasoningExpand')}
        </span>
      </button>
      {showBody ? (
        <div
          ref={scrollRef}
          className="mt-1 max-h-[min(22vh,140px)] overflow-y-auto overflow-x-hidden rounded-md bg-stone-200/35 px-2 py-1.5 dark:bg-slate-900/50"
        >
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-stone-800 dark:text-slate-200">
            {reasoning}
          </pre>
        </div>
      ) : null}
    </div>
  );
};

export default AssistantReasoningCollapsible;
