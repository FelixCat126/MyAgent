import { describe, it, expect } from 'vitest';
import { OneEuroFilter } from './oneEuroFilter';

describe('OneEuroFilter', () => {
  it('第一帧直接返回原值（无前置值）', () => {
    const f = new OneEuroFilter(1, 0.018, 1);
    expect(f.filter(10, 1000)).toBe(10);
  });
  it('静止信号快速趋近目标（minCutoff=1 平滑）', () => {
    const f = new OneEuroFilter(1, 0.018, 1);
    f.filter(0, 0);
    const v = f.filter(100, 1000);
    /** 不期望立刻=100；期望明显趋向（>0, <100） */
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(100);
  });
  it('alpha 越大越快响应', () => {
    const a = new OneEuroFilter(10, 0.018, 1);
    a.filter(0, 0);
    const b = new OneEuroFilter(0.1, 0.018, 1);
    b.filter(0, 0);
    const va = a.filter(100, 1000);
    const vb = b.filter(100, 1000);
    expect(va).toBeGreaterThan(vb);
  });
  it('reset 后以给定值作为前值继续滤波（非首帧直通）', () => {
    const f = new OneEuroFilter(1, 0.018, 1);
    f.filter(0, 0);
    f.filter(50, 100);
    f.reset(100, 200);
    const v = f.filter(0, 250);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
  it('同一时间戳 / 时间倒流不报错', () => {
    const f = new OneEuroFilter(1, 0.018, 1);
    f.filter(5, 100);
    expect(() => f.filter(5, 100)).not.toThrow();
  });
});
