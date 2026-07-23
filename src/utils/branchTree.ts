/**
 * 分支树派生纯函数：从 messages 与当前 activeLeafId 沿 parent 链回溯，
 * 给出"当前显示路径"——从根到叶的有序 id 数组。
 *
 * 用途：UI 渲染消息列表时按本路径过滤（隐藏非激活分支的兄弟），
 * 切换分支时仅需更新 activeLeafId 即可重渲染。
 */

import type { Message } from '../types/message';

/** 消息 id → message 的 O(1) 索引 */
function buildIndex(messages: Message[]): Map<string, Message> {
  const idx = new Map<string, Message>();
  for (const m of messages) idx.set(m.id, m);
  return idx;
}

/**
 * 返回从根到 activeLeafId 的 id 链；若 activeLeafId 缺失或不在 messages 中则返回空数组。
 * 循环安全：若 parentId 形成环（不应发生），跑到已访问集合即停。
 */
export function getDerivedActivePath(messages: Message[], activeLeafId: string | null): string[] {
  if (!activeLeafId) return [];
  const idx = buildIndex(messages);
  if (!idx.has(activeLeafId)) return [];
  const path: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = activeLeafId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.unshift(cur);
    const node = idx.get(cur);
    if (!node) break;
    cur = typeof node.parentId === 'string' ? node.parentId : null;
  }
  return path;
}

/**
 * 拿到一个 message 的所有兄弟（同一 parentId 下的其它 child），用于分支选择器 UI 列出可选分支。
 */
export function getSiblingsOf(messages: Message[], messageId: string): Message[] {
  const target = messages.find((m) => m.id === messageId);
  if (!target) return [];
  const pid = target.parentId;
  return messages.filter((m) => m.parentId === pid);
}

/**
 * 一条 message 是否有"分叉"（有 >1 个子）。
 * UI 借此显示分支选择器入口。
 */
export function hasBranch(messages: Message[], messageId: string): boolean {
  const m = messages.find((x) => x.id === messageId);
  return Boolean(m && Array.isArray(m.children) && m.children.length > 1);
}

/** 解析会话有效叶：显式 activeLeafId → 否则末条 id */
export function resolveActiveLeafId(
  messages: Message[],
  activeLeafId?: string | null
): string | null {
  if (activeLeafId && messages.some((m) => m.id === activeLeafId)) return activeLeafId;
  if (messages.length === 0) return null;
  return messages[messages.length - 1]!.id;
}

/** 当前激活路径上的消息列表；无叶时回退全量（兼容线性会话） */
export function getActiveMessages(
  messages: Message[],
  activeLeafId?: string | null
): Message[] {
  const leaf = resolveActiveLeafId(messages, activeLeafId);
  if (!leaf) return messages;
  const path = getDerivedActivePath(messages, leaf);
  if (path.length === 0) return messages;
  const idx = buildIndex(messages);
  return path.map((id) => idx.get(id)).filter((m): m is Message => Boolean(m));
}

/** 某消息在同父兄弟中的序号（1-based）与总数；无兄弟时 total=1 */
export function getSiblingNav(
  messages: Message[],
  messageId: string
): { index: number; total: number; siblingIds: string[] } {
  const siblings = getSiblingsOf(messages, messageId);
  const siblingIds = siblings.map((m) => m.id);
  const index = Math.max(0, siblingIds.indexOf(messageId));
  return { index: index + 1, total: siblingIds.length, siblingIds };
}

/** 收集 rootId 的全部后代 id（不含自身），用于编辑重发清理分支尾部 */
export function collectDescendantIds(messages: Message[], rootId: string): string[] {
  const byId = buildIndex(messages);
  if (!byId.has(rootId)) return [];
  const out: string[] = [];
  const stack = [...(byId.get(rootId)?.children ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const kids = byId.get(id)?.children ?? [];
    for (const k of kids) stack.push(k);
  }
  return out;
}
