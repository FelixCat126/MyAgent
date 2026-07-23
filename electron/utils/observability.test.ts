/** 观测层：日志门面 + metrics 的核心契约 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StructuredLogger } from './logger';
import { incCounter, getCounter, listCounters, uptimeSec } from './metrics';

describe('StructuredLogger', () => {
  let lines: string[];
  let log: StructuredLogger;

  beforeEach(() => {
    lines = [];
    log = new StructuredLogger('test', { app: 'demo' }, { dev: false, writer: (l) => lines.push(l) });
  });

  it('honors minLevel and drops below', () => {
    const quiet = new StructuredLogger('q', {}, { dev: false, minLevel: 'warn', writer: (l) => lines.push(l) });
    quiet.debug('d', { x: 1 });
    quiet.info('i', { x: 2 });
    quiet.warn('w', { x: 3 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe('warn');
  });

  it('emits JSON one-line per call with bound + per-call fields merged', () => {
    log.info('hello', { extra: 42 });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.name).toBe('test');
    expect(parsed.msg).toBe('hello');
    expect(parsed.app).toBe('demo');
    expect(parsed.extra).toBe(42);
    expect(parsed.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('child inherits bound and overrides per-call', () => {
    const child = log.child({ requestId: 'r-1' });
    child.info('c', { extra: 'x' });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.app).toBe('demo');
    expect(parsed.requestId).toBe('r-1');
    expect(parsed.extra).toBe('x');
  });

  it('addWriter broadcasts to every writer', () => {
    const sinkB: string[] = [];
    log.addWriter((l) => sinkB.push(l));
    log.info('two-sinks');
    expect(lines).toHaveLength(1);
    expect(sinkB).toHaveLength(1);
  });

  it('writer exceptions do not abort the chain', () => {
    const noisy = new StructuredLogger('n', {}, { dev: false, writer: () => { throw new Error('boom'); } });
    const sinkC: string[] = [];
    noisy.addWriter((l) => sinkC.push(l));
    expect(() => noisy.info('still-here')).not.toThrow();
    expect(sinkC).toHaveLength(1);
  });
});

describe('metrics', () => {
  beforeEach(() => {
    // 清空计数（用 Object.keys 枚举再 unset；模块内 counter 在测试间共享）
    for (const k of Object.keys(listCounters())) delete (listCounters() as Record<string, unknown>)[k];
  });

  it('incCounter accumulates and tracks lastAt', () => {
    const t0 = Date.now();
    incCounter('x');
    incCounter('x');
    const c = getCounter('x');
    expect(c?.total).toBe(2);
    expect(c?.lastAt).toBeGreaterThanOrEqual(t0);
  });

  it('uptimeSec is non-negative and monotonically increasing', () => {
    const a = uptimeSec();
    const b = uptimeSec();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('getCounter returns undefined for unknown name', () => {
    expect(getCounter('does-not-exist')).toBeUndefined();
  });
});
