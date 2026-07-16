import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChatAttachmentsApi {
  attachments: File[];
  attachmentPreviews: Record<string, string>;
  setAttachments: React.Dispatch<React.SetStateAction<File[]>>;
  setAttachmentPreviews: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  isDragging: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
  handleFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  removeAttachment: (index: number) => void;
  /** 发送成功后清空（setAttachments([]) + setAttachmentPreviews({})） */
  clearAttachments: () => void;
}

/**
 * 附件管理：拖拽 / 文件选择 / 缩略图（URL.createObjectURL 生命周期）/ 移除。
 * 卸载时 revoke 所有 URL。
 */
export function useChatAttachments(): ChatAttachmentsApi {
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 卸载时回收所有预览 URL
  useEffect(() => {
    return () => {
      Object.values(attachmentPreviews).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [attachmentPreviews]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      const files = Array.from(e.dataTransfer.files);
      setAttachments((prev) => [...prev, ...files]);
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          setAttachmentPreviews((p) => ({ ...p, [f.name]: url }));
        }
      }
    }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files as FileList);
      setAttachments((prev) => [...prev, ...files]);
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          setAttachmentPreviews((p) => ({ ...p, [f.name]: url }));
        }
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const removeAttachment = useCallback(
    (index: number) => {
      const removed = attachments[index];
      setAttachments((prev) => prev.filter((_, i) => i !== index));
      if (removed && removed.name in attachmentPreviews) {
        URL.revokeObjectURL(attachmentPreviews[removed.name]);
        setAttachmentPreviews((p) => {
          const np = { ...p };
          delete np[removed.name];
          return np;
        });
      }
    },
    [attachments, attachmentPreviews]
  );

  const clearAttachments = useCallback(() => {
    setAttachments([]);
    setAttachmentPreviews({});
  }, []);

  return {
    attachments,
    attachmentPreviews,
    setAttachments,
    setAttachmentPreviews,
    isDragging,
    fileInputRef,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileInput,
    removeAttachment,
    clearAttachments,
  };
}