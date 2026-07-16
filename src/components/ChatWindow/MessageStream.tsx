import React, { useMemo } from 'react';
import MessageItem from '../MessageItem';
import AgentBrowserPanel from '../AgentBrowserPanel';
import { FiLoader } from 'react-icons/fi';
import {
  buildConversationImageGallery,
  findConversationGalleryIndex,
  type ConversationImageGalleryItem,
} from '../../utils/conversationImageGallery';
import type { Message } from '../../types';

export interface MessageStreamProps {
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  messages: Message[];
  isStreaming: boolean;
  streamingTargetAssistantId: string | null;
  selectionMode: boolean;
  selectedMessageIds: Set<string>;
  onToggleSelect: (messageId: string) => void;
  onStartSelect: (messageId?: string) => void;
  onEdit: (message: Message) => void;
  editingMessageId: string | null;
  onSubmitEdit: (message: Message, next: string) => void;
  onCancelEdit: () => void;
  imageGenProgress: { current: number; total: number; messageId: string } | null;
  onOpenConversationGallery: (messageId: string, fileIndex: number) => void;
  showTypingDots: boolean;
  isCompressingCurrent: boolean;
  footerH: number;
  attachmentStripH: number;
  attachmentsLength: number;
  emptyLabel: string;
  newConversationDividerLabel: string;
  compressingLabel: string;
}

export const MessageStream: React.FC<MessageStreamProps> = (p) => {
  const conversationGallery: ConversationImageGalleryItem[] = useMemo(
    () => buildConversationImageGallery(p.messages),
    [p.messages]
  );

  /** 新对话分隔线：同一会话内，若最后两条消息间隔超过阈值，在间隔处显示一条"以下为新对话内容"。 */
  const newConversationDividerIndex = useMemo(() => {
    const GAP_MS = 15 * 60 * 1000;
    if (p.messages.length < 2) return -1;
    for (let i = p.messages.length - 1; i >= 1; i--) {
      const prev = p.messages[i - 1];
      const curr = p.messages[i];
      if (
        typeof prev?.timestamp === 'number' &&
        typeof curr?.timestamp === 'number' &&
        curr.timestamp - prev.timestamp >= GAP_MS
      ) {
        return i;
      }
    }
    return -1;
  }, [p.messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={p.scrollContainerRef}
        data-gesture-scroll-target="chat"
        className="min-h-0 flex-1 overflow-y-auto px-8 py-4 space-y-4"
        style={{
          paddingBottom: `calc(${p.footerH + (p.attachmentsLength > 0 ? p.attachmentStripH : 0)}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        {p.messages.length === 0 && (
          <div className="flex items-center justify-center h-64 text-stone-400 dark:text-slate-500">
            <p className="text-lg">{p.emptyLabel}</p>
          </div>
        )}

        {p.messages.map((message, index) => {
          const reasoningTrim = (message.reasoning ?? '').trim();
          const hideEmptyStreamBubble =
            p.isStreaming &&
            message.role === 'assistant' &&
            message.id === p.streamingTargetAssistantId &&
            !(message.content ?? '').trim().length &&
            !reasoningTrim.length;
          if (hideEmptyStreamBubble) return <React.Fragment key={message.id} />;
          return (
            <React.Fragment key={message.id}>
              {index === newConversationDividerIndex && (
                <div
                  className="flex items-center gap-3 py-1"
                  role="separator"
                  aria-label={p.newConversationDividerLabel}
                >
                  <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
                  <span className="text-[10px] font-medium text-stone-400 dark:text-slate-500 whitespace-nowrap">
                    {p.newConversationDividerLabel}
                  </span>
                  <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
                </div>
              )}
              <MessageItem
                key={message.id}
                message={message}
                onEdit={message.role === 'user' ? p.onEdit : undefined}
                editing={p.editingMessageId === message.id}
                onSubmitEdit={p.onSubmitEdit}
                onCancelEdit={p.onCancelEdit}
                selectionMode={p.selectionMode}
                selected={p.selectedMessageIds.has(message.id)}
                onToggleSelect={p.onToggleSelect}
                onStartSelect={p.onStartSelect}
                conversationStreaming={p.isStreaming}
                streamingAssistantId={p.streamingTargetAssistantId}
                showInlineStreamPlaceholder={
                  !!p.isStreaming &&
                  message.role === 'assistant' &&
                  message.id === p.streamingTargetAssistantId &&
                  !(message.content ?? '').trim().length &&
                  !!(message.reasoning ?? '').trim().length
                }
                conversationGallery={conversationGallery}
                onOpenConversationGallery={(messageId, fileIndex) => {
                  const idx = findConversationGalleryIndex(
                    conversationGallery,
                    messageId,
                    fileIndex
                  );
                  if (idx >= 0) p.onOpenConversationGallery(messageId, fileIndex);
                }}
                imageGenProgress={
                  p.imageGenProgress && p.imageGenProgress.messageId === message.id
                    ? { current: p.imageGenProgress.current, total: p.imageGenProgress.total }
                    : message.imageGenProgress
                }
              />
            </React.Fragment>
          );
        })}

        {p.showTypingDots && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 text-stone-500 dark:text-slate-500 text-sm px-5 py-3.5 bg-stone-100 dark:bg-slate-800 rounded-2xl rounded-tl-sm border border-stone-300/45 dark:border-white/5">
              <div className="flex gap-1">
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
            </div>
          </div>
        )}

        {p.isCompressingCurrent ? (
          <div
            className="flex items-center gap-3 py-2"
            role="status"
            aria-live="polite"
            aria-label={p.compressingLabel}
          >
            <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-stone-500 dark:text-slate-400 whitespace-nowrap">
              <FiLoader size={12} className="animate-spin shrink-0 opacity-80" aria-hidden />
              {p.compressingLabel}
            </span>
            <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
          </div>
        ) : null}

        <div />
      </div>
      <AgentBrowserPanel />
    </div>
  );
};