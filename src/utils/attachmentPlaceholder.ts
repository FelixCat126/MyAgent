/** 用户只传附件、无正文时写入 message.content 的占位（与 i18n chat.attachment 对齐） */
export const ATTACHMENT_PLACEHOLDERS = ['（附件）', '(attachment)'] as const;

export function isAttachmentPlaceholder(text: string): boolean {
  const t = text.trim();
  return (ATTACHMENT_PLACEHOLDERS as readonly string[]).includes(t);
}
