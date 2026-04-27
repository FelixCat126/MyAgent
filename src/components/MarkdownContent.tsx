import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  text: string;
  className?: string;
}

/**
 * 助手消息正文：GFM 表格、列表、代码块等
 */
const MarkdownContent: React.FC<MarkdownContentProps> = ({ text, className = '' }) => {
  return (
    <div className={`myagent-md text-sm leading-relaxed ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
};

export default MarkdownContent;
