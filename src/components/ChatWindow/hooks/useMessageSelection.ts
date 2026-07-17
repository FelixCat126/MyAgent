import { useCallback, useState } from 'react';

export interface MessageSelectionApi {
  selectionMode: boolean;
  selectedMessageIds: Set<string>;
  startSelection: (messageId?: string) => void;
  toggleMessageSelection: (messageId: string) => void;
  cancelSelection: () => void;
  deleteSelectedMessages: (params: {
    currentSessionId: string | null;
    editingMessageId: string | null;
    setEditingMessageId: (id: string | null) => void;
    confirm: (message: string) => boolean | Promise<boolean>;
    removeMessages: (sessionId: string, ids: string[]) => void;
    label: string;
  }) => void;
}

/**
 * 多选状态（selectionMode / selectedMessageIds / 选/反选/删除 逻辑）。
 * deleteSelectedMessages 的副作用（removeMessages / 编辑清空 / confirm）由调用方注入，
 * hook 本身不持有 store 或 i18n。
 */
export function useMessageSelection(): MessageSelectionApi {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set());

  const startSelection = useCallback((messageId?: string) => {
    setSelectionMode(true);
    setSelectedMessageIds(messageId ? new Set([messageId]) : new Set());
  }, []);

  const toggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const cancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const deleteSelectedMessages = useCallback(
    (params: {
      currentSessionId: string | null;
      editingMessageId: string | null;
      setEditingMessageId: (id: string | null) => void;
      confirm: (message: string) => boolean | Promise<boolean>;
      removeMessages: (sessionId: string, ids: string[]) => void;
      label: string;
    }) => {
      const {
        currentSessionId,
        editingMessageId,
        setEditingMessageId,
        confirm,
        removeMessages,
        label,
      } = params;
      if (!currentSessionId || selectedMessageIds.size === 0) return;
      void Promise.resolve(confirm(label)).then((ok) => {
        if (!ok) return;
        if (editingMessageId && selectedMessageIds.has(editingMessageId)) setEditingMessageId(null);
        removeMessages(currentSessionId, [...selectedMessageIds]);
        cancelSelection();
      });
    },
    [selectedMessageIds, cancelSelection]
  );

  return {
    selectionMode,
    selectedMessageIds,
    startSelection,
    toggleMessageSelection,
    cancelSelection,
    deleteSelectedMessages,
  };
}