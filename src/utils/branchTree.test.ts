/** 分支树派生纯函数 */
import { describe, it, expect } from 'vitest';
import {
  collectDescendantIds,
  getActiveMessages,
  getDerivedActivePath,
  getSiblingNav,
  getSiblingsOf,
  hasBranch,
  resolveActiveLeafId,
} from './branchTree';
import type { Message } from '../types/message';

function m(
  id: string,
  parentId: string | null = null,
  children: string[] = []
): Message {
  return {
    id,
    role: 'user',
    content: '',
    timestamp: 0,
    model: '',
    parentId: parentId ?? undefined,
    children,
  };
}

describe('getDerivedActivePath', () => {
  it('空 activeLeafId 返回空数组', () => {
    expect(getDerivedActivePath([], null)).toEqual([]);
  });

  it('线性链返回根到叶', () => {
    const msgs = [m('r'), m('a', 'r'), m('u', 'a'), m('b', 'u')];
    expect(getDerivedActivePath(msgs, 'b')).toEqual(['r', 'a', 'u', 'b']);
  });

  it('activeLeafId 不在 messages 中返回空数组', () => {
    const msgs = [m('r'), m('a', 'r')];
    expect(getDerivedActivePath(msgs, 'missing')).toEqual([]);
  });

  it('分支链：选某分支的叶，路径应穿过共同祖先', () => {
    const msgs = [
      m('r'),
      m('a', 'r', ['b1', 'b2']),
      m('b1', 'a', ['c']),
      m('b2', 'a'),
      m('c', 'b1'),
    ];
    expect(getDerivedActivePath(msgs, 'c')).toEqual(['r', 'a', 'b1', 'c']);
    expect(getDerivedActivePath(msgs, 'b2')).toEqual(['r', 'a', 'b2']);
  });

  it('环形 parent 链防御：跑到已访问集合即停', () => {
    const cycle = m('a');
    cycle.parentId = 'a'; // 自环
    expect(getDerivedActivePath([cycle], 'a')).toEqual(['a']);
  });
});

describe('getSiblingsOf', () => {
  it('返回同 parentId 下的其它 message（含自己时减一）', () => {
    const msgs = [m('a', 'r', ['x', 'y', 'z']), m('x', 'a'), m('y', 'a'), m('z', 'a')];
    expect(getSiblingsOf(msgs, 'x').map((s) => s.id).sort()).toEqual(['x', 'y', 'z']);
  });

  it('目标不存在返回空', () => {
    expect(getSiblingsOf([], 'x')).toEqual([]);
  });
});

describe('hasBranch', () => {
  it('children 长度 > 1 视为分叉', () => {
    const msgs = [m('a', null, ['x', 'y']), m('x', 'a'), m('y', 'a')];
    expect(hasBranch(msgs, 'a')).toBe(true);
  });

  it('单 child 不算分叉', () => {
    const msgs = [m('a', null, ['x']), m('x', 'a')];
    expect(hasBranch(msgs, 'a')).toBe(false);
  });

  it('无 children 不算分叉', () => {
    const msgs = [m('a', null, [])];
    expect(hasBranch(msgs, 'a')).toBe(false);
  });
});

describe('getActiveMessages / resolveActiveLeafId / getSiblingNav / collectDescendantIds', () => {
  it('resolveActiveLeafId 优先显式叶，否则末条', () => {
    const msgs = [m('a'), m('b', 'a')];
    expect(resolveActiveLeafId(msgs, 'a')).toBe('a');
    expect(resolveActiveLeafId(msgs, null)).toBe('b');
  });

  it('getActiveMessages 仅返回激活路径', () => {
    const msgs = [
      m('r'),
      m('a', 'r', ['b1', 'b2']),
      m('b1', 'a'),
      m('b2', 'a'),
    ];
    expect(getActiveMessages(msgs, 'b2').map((x) => x.id)).toEqual(['r', 'a', 'b2']);
  });

  it('getSiblingNav 给出 1-based 序号', () => {
    const msgs = [m('a', null, ['x', 'y']), m('x', 'a'), m('y', 'a')];
    expect(getSiblingNav(msgs, 'y')).toEqual({
      index: 2,
      total: 2,
      siblingIds: ['x', 'y'],
    });
  });

  it('collectDescendantIds 不含自身', () => {
    const msgs = [
      m('u', null, ['a1', 'a2']),
      m('a1', 'u', ['c']),
      m('a2', 'u'),
      m('c', 'a1'),
    ];
    expect(collectDescendantIds(msgs, 'u').sort()).toEqual(['a1', 'a2', 'c']);
  });
});
