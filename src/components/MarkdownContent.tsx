import React, { type ReactNode, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface MarkdownContentProps {
  text: string;
  className?: string;
  /** 代码块右上角「一键复制」按钮文案 */
  copyCodeLabel?: string;
}

function stringifyChildren(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(stringifyChildren).join('');
  if (React.isValidElement<{ children?: ReactNode }>(node))
    return stringifyChildren(node.props.children);
  return '';
}

/**
 * 模型偶发把围栏粘在 *…* / 单独 * 行前，GFM 会解析成 code∈em∈p，使自定义围栏含 div/pre 触发 DOM 嵌套告警。
 */
function normalizeMarkdownForBlockFence(md: string): string {
  let s = md.replace(/\r\n/g, '\n');
  s = s.replace(/^(\s*)\*{1,2}\s*(```+)/gm, '$1$2');
  s = s.replace(/^(\s*)\*\s*\n(?=\s*```+)/gm, '$1');
  s = s.replace(/\*\s*\n(```[\s\S]*?```)\s*\*/g, '$1');
  return s;
}

/** 整块 fenced 代码的头部工具条 + 一键复制（必须独立组件后才能使用 hooks） */
function FencedCodeBlock(props: {
  className?: string;
  rawText: string;
  copyLabel: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const lang = /\blanguage-([^\s]+)\b/i.exec(String(props.className || ''))?.[1] ?? '';
  return (
    <div className="group/code relative my-2 overflow-hidden rounded-lg border border-stone-300/65 bg-[#faf8f5] shadow-sm dark:border-slate-600/60 dark:bg-slate-900/95">
      <div className="flex items-center justify-between gap-2 border-b border-stone-300/55 bg-stone-200/85 px-2 py-1 text-[11px] text-stone-600 dark:border-slate-600/50 dark:bg-slate-800/90 dark:text-slate-400">
        <span className="font-mono tabular-nums opacity-85">{lang || 'text'}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(props.rawText);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch {}
          }}
          className="rounded px-2 py-0.5 font-medium text-primary-700 transition-colors hover:bg-white/65 dark:text-primary-300 dark:hover:bg-slate-700/85"
          title={props.copyLabel}
        >
          {copied ? '√' : props.copyLabel}
        </button>
      </div>
      <pre className="m-0 max-h-[min(70vh,520px)] overflow-auto px-3 py-2 font-mono text-[13px] leading-relaxed text-stone-900 dark:text-slate-100">
        <code className={props.className}>{props.children}</code>
      </pre>
    </div>
  );
}

type CodeProps = {
  inline?: boolean;
  className?: string;
  children?: ReactNode;
};

/**
 * 助手消息正文：GFM 表格、列表等； fenced 代码块带复制按钮
 */
const MarkdownContent: React.FC<MarkdownContentProps> = ({
  text,
  className = '',
  copyCodeLabel = '复制',
}) => {
  const mdComponents: Partial<Components> = {
    /** paragraph 改用 div：允许与块级自定义组件共存且不触发 validateDOMNesting */
    p: ({ children }) => <div className="myagent-md-p">{children}</div>,
    /** 默认 </pre><code> 中我们渲染含 div 的 fenced 组件，去掉 pre 壳避免 pre>div */
    pre({ children }: { children?: ReactNode }) {
      return <>{children}</>;
    },
    code({ inline, className: cn, children }: CodeProps) {
      if (inline) {
        return (
          <code
            className={`rounded bg-stone-200/90 px-1 py-px font-mono text-[90%] dark:bg-slate-700 dark:text-slate-100 ${cn ?? ''}`}
          >
            {children}
          </code>
        );
      }
      const raw = stringifyChildren(children).replace(/\n$/, '');
      return <FencedCodeBlock className={cn} rawText={raw} copyLabel={copyCodeLabel} children={children} />;
    },
  };

  return (
    <div className={`myagent-md text-sm leading-relaxed ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {normalizeMarkdownForBlockFence(text)}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownContent;
