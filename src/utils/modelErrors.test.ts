import { describe, expect, it } from 'vitest';
import { mapModelCallError } from './modelErrors';

describe('mapModelCallError', () => {
  it('超时', () => {
    expect(mapModelCallError({ code: 'ECONNABORTED' })).toContain('超时');
  });
  it('无法连接', () => {
    expect(mapModelCallError({ code: 'ECONNREFUSED' })).toContain('无法连接');
    expect(mapModelCallError({ code: 'ERR_NETWORK', message: 'Network Error' })).toContain('无法连接');
  });
  it('ENOENT 无附件文案时用通用提示', () => {
    expect(mapModelCallError({ code: 'ENOENT', message: 'missing' })).toContain('不存在');
  });
  it('ENOENT 含附件说明时保留原文', () => {
    expect(
      mapModelCallError({ code: 'ENOENT', message: '附件图片在本地已找不到 x' })
    ).toContain('附件');
  });
  it('401', () => {
    expect(mapModelCallError({ response: { status: 401 } })).toContain('认证');
  });
  it('403', () => {
    expect(mapModelCallError({ response: { status: 403 } })).toContain('拒绝访问');
  });
  it('429', () => {
    expect(mapModelCallError({ response: { status: 429 } })).toContain('429');
  });
  it('502/503', () => {
    expect(mapModelCallError({ response: { status: 503 } })).toContain('503');
  });
  it('内容策略类错误会附原文说明', () => {
    const msg = mapModelCallError({
      response: { status: 400, data: { message: 'content policy violation' } },
    });
    expect(msg).toContain('策略');
  });
  it('上下文过长', () => {
    const msg = mapModelCallError({
      response: { status: 400, data: { message: 'maximum context length exceeded' } },
    });
    expect(msg).toContain('上下文过长');
  });
});
