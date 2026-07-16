import React from 'react';

/** 流式输出占位：三个跳动的小圆点（·） */
const InlineStreamDots: React.FC = () => {
  return (
    <div className="flex gap-1 text-stone-500 dark:text-slate-500 text-sm" aria-hidden>
      <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
        ·
      </span>
      <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
        ·
      </span>
      <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
        ·
      </span>
    </div>
  );
};

export default InlineStreamDots;
