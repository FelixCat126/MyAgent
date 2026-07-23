/**
 * 发送前按路由规则挑选模型；未命中则回退 activeModel。
 */

import type { Message, ModelConfig } from '../types';
import {
  BUILTIN_ROUTING_RULES,
  detectContainsCode,
  pickModelId,
  type RouteContext,
  type RouteKind,
  type RoutingRule,
} from './modelRouting';

export function resolveSendModel(opts: {
  models: ModelConfig[];
  activeModel: ModelConfig;
  routingRules: RoutingRule[];
  history: Message[];
  userText: string;
  hasImages: boolean;
  kind?: RouteKind;
}): ModelConfig {
  const rules = opts.routingRules.length > 0 ? opts.routingRules : BUILTIN_ROUTING_RULES;
  const msgs = [
    ...opts.history.map((m) => ({ role: m.role, content: m.content ?? '' })),
    { role: 'user' as const, content: opts.userText },
  ];
  const totalLen = msgs.reduce((s, m) => s + m.content.length, 0);
  const containsCode = detectContainsCode(msgs);
  const kind: RouteKind = opts.kind ?? (containsCode ? 'code' : 'chat');
  const ctx: RouteContext = {
    kind,
    messagesLen: msgs.length,
    hasImages: opts.hasImages,
    containsCode,
    averageMessageLen: msgs.length ? totalLen / msgs.length : 0,
    lastRole: 'user',
  };
  const picked = pickModelId(rules, ctx, opts.models);
  if (!picked) return opts.activeModel;
  return opts.models.find((m) => m.id === picked) ?? opts.activeModel;
}
