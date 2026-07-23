/**
 * 模型路由规则引擎。
 *
 * 设计目标：纯函数 + 可序列化规则，存到 modelStore 持久化（不引入 LLM-as-router，
 * 那会抵消多模型成本优势）。
 *
 * 形态：每条规则是一条「匹配条件 + 命中模型 id」。规则按数组顺序求值，首条命中即胜出。
 * 条件类型：
 *  - kind: chat/image/code/summarize（4 选 1，可缺省视为全匹配）
 *  - messagesLenAtLeast: 当前会话消息数门槛
 *  - hasImages: 是否含图片附件
 *  - containsCode: 最近一条用户消息是否像代码（极简启发：包含反引号或常见关键字）
 *  - longContext: 消息数 × 平均长度超过阈值
 *
 * 落选 = 没规则命中 → caller 退回到 modelStore.activeModelId。
 */

import type { ModelConfig } from '../types/model';

export type RouteKind = 'chat' | 'image' | 'code' | 'summarize';

export interface RouteContext {
  kind: RouteKind;
  messagesLen: number;
  hasImages: boolean;
  containsCode: boolean;
  /** 累计平均消息字符数（用于 longContext 启发） */
  averageMessageLen: number;
  /** 当前会话最近一次的角色（用于 summarize 推断） */
  lastRole: 'user' | 'assistant' | 'system';
}

export interface RoutingRule {
  id: string;
  description: string;
  enabled: boolean;
  /** 全部条件 AND 命中；缺省字段视为不限制 */
  match: Partial<{
    kind: RouteKind;
    messagesLenAtLeast: number;
    hasImages: boolean;
    containsCode: boolean;
    longContextAvgAtLeast: number;
  }>;
  /** 命中所用模型 id；落选时引擎继续下一条 */
  preferModelId: string;
}

/** 启发：判断最近一条用户消息是否像代码 */
export function detectContainsCode(messages: Array<{ role: string; content: string }>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const c = m.content;
    if (c.length > 0) {
      if (c.includes('```')) return true;
      if (c.includes('function ') || c.includes('def ') || c.includes('class ')) return true;
      if (c.includes('=>') || c.includes(';') || c.includes('{}')) return true;
    }
    break;
  }
  return false;
}

/** 单条规则是否匹配给定 ctx */
export function matchesRule(rule: RoutingRule, ctx: RouteContext): boolean {
  if (!rule.enabled) return false;
  const m = rule.match;
  if (m.kind && m.kind !== ctx.kind) return false;
  if (typeof m.messagesLenAtLeast === 'number' && ctx.messagesLen < m.messagesLenAtLeast) return false;
  if (m.hasImages !== undefined && m.hasImages !== ctx.hasImages) return false;
  if (m.containsCode !== undefined && m.containsCode !== ctx.containsCode) return false;
  if (typeof m.longContextAvgAtLeast === 'number' && ctx.averageMessageLen < m.longContextAvgAtLeast)
    return false;
  return true;
}

/**
 * 命中即返：返回推荐 modelId；落选返 null（caller 用 activeModelId 兜底）。
 * 校验推荐 modelId 在 models 列表里存在，否则跳过该条（避免迁移/删除后误用）。
 */
export function pickModelId(
  rules: RoutingRule[],
  ctx: RouteContext,
  models: ModelConfig[]
): string | null {
  for (const r of rules) {
    if (!matchesRule(r, ctx)) continue;
    const exists = models.some((m) => m.id === r.preferModelId);
    if (!exists) continue;
    return r.preferModelId;
  }
  return null;
}

/** 推断会话长上下文：消息数 × 平均长度 > 阈值 */
export function isLongContext(ctx: RouteContext, threshold = 1200): boolean {
  return ctx.messagesLen * ctx.averageMessageLen > threshold;
}

/** 内置三条规则：长上下文→便宜模型；含代码→代码模型；含图片→vision 模型 */
export const BUILTIN_ROUTING_RULES: RoutingRule[] = [
  {
    id: 'builtin:long-context-cheap',
    description: '长上下文/多轮对话使用便宜模型',
    enabled: true,
    match: { kind: 'chat', messagesLenAtLeast: 20, longContextAvgAtLeast: 1200 },
    preferModelId: '',
  },
  {
    id: 'builtin:code-task',
    description: '用户消息含代码/技术内容走代码模型',
    enabled: true,
    match: { kind: 'code', containsCode: true },
    preferModelId: '',
  },
  {
    id: 'builtin:image-task',
    description: '含图片附件走视觉模型',
    enabled: true,
    match: { kind: 'chat', hasImages: true },
    preferModelId: '',
  },
];
