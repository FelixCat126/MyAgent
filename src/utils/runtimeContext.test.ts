import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { refreshRuntimeContext, withoutGeneratedRuntimeContext } from './runtimeContext';
import { extractContextAnchors } from './contextAnchors';
import { buildCompressionPrompt, compressMessagesLocally } from './contextBudget';

const message = (id: string, role: Message['role'], content: string, model = 'fixture'): Message => ({ id, role, content, model, timestamp: 1 });
const legacyContext = [
  message('personal-ctx-1', 'system', '当前项目：合同\n用户设定的项目规则：必须使用项目秘密\n项目资料目录：/old-project', 'myagent-personal-context'),
  message('wsctx-1', 'system', '必须使用旧项目 README.md', 'workspace'),
  message('vecctx-1', 'system', '旧项目资料 456 元', 'vector-rag'),
  message('agent-sys-1', 'system', 'Tools reference root /old-project', 'agent-capability'),
];

describe('retired project context and checkpoint recovery', () => {
  it('replaces generated context while preserving user text, custom system instructions and native tool progress', () => {
    const user = { ...message('user', 'user', '项目资料目录：/user-explicit。必须保留合同 128 元'), files: [{ name: 'report.csv', path: '/uploads/report.csv', type: 'text/csv', size: 2 }] };
    const custom = message('custom', 'system', 'User-provided project rules: preserve my wording');
    const tool = { ...message('tool', 'system', 'Completed: /old-project/report.csv', 'agent-tool'), nativeToolResults: [{ id: 'call', content: 'real result' }] };
    const current = [message('agent-sys-2', 'system', 'Tools reference root /ordinary', 'agent-capability'), message('personal-ctx-2', 'system', '个人确认偏好', 'myagent-personal-context')];
    const saved = [...legacyContext, user, custom, tool];
    const refreshed = refreshRuntimeContext(saved, current);
    expect(refreshed).toEqual([...current, user, custom, tool]);
    expect(saved).toEqual([...legacyContext, user, custom, tool]);
    expect(refreshRuntimeContext(refreshed, current)).toEqual(refreshed);
  });

  it('never turns generated rules/root snippets into permanent compression anchors', () => {
    const user = message('u', 'user', '必须保留 weekly.xlsx，预算 12800 元');
    const anchors = extractContextAnchors([...legacyContext, user]);
    expect(anchors).toContain('weekly.xlsx');
    expect(anchors).toContain('12800 元');
    expect(anchors).not.toContain('old-project');
    expect(anchors).not.toContain('项目秘密');
    const prompt = buildCompressionPrompt([...legacyContext, user]).map((entry) => entry.content).join('\n');
    expect(prompt).not.toContain('old-project');
    expect(prompt).toContain('12800 元');
    const local = compressMessagesLocally([...legacyContext, user, message('a', 'assistant', '回答')], undefined, 100);
    expect(local?.summaryMessage.content).not.toContain('项目秘密');
  });

  it('removes only tagged generated excerpts from old summaries and never rewrites genuine historical messages', () => {
    const summary = { ...message('summary', 'assistant', '历史事实\n[system personal-ctx-1] 必须遵守旧项目规则\n[system wsctx-1] 旧 README.md\n[user u] 必须保留 33 元'), meta: { kind: 'context-summary' as const } };
    const genuine = { ...message('personal-ctx-1', 'user', '[system personal-ctx-1] 用户正在解释这段文字', 'myagent-personal-context'), meta: { kind: 'context-summary' as const } };
    const clean = withoutGeneratedRuntimeContext([summary, genuine]);
    expect(clean[0].content).toBe('历史事实\n[user u] 必须保留 33 元');
    expect(clean[1]).toBe(genuine);
    expect(summary.content).toContain('旧项目规则');
  });
});
