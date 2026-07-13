import { describe, expect, it } from 'vitest';

/**
 * 与 electron/ipc/image-gen.ts 中 MiniMax 错误码提示保持同步的轻量单测。
 * 主进程模块依赖 electron，此处复刻纯函数逻辑做契约校验。
 */
function formatMiniMaxStatusError(
  statusCode: number,
  statusMsg: string,
  meta?: { host?: string; authSource?: string; keyHint?: string }
): string {
  const hints: Record<number, string> = {
    1002: '触发限流，请稍后重试',
    1004: '账号鉴权失败，请检查 API Key 是否正确、是否填写在生图模型「API 密钥」',
    1008: '账户余额不足，请前往 MiniMax 开放平台充值',
    1026: '提示词含敏感内容，请修改后再试',
    2013: '请求参数无效：请确认模型名为 image-01，Endpoint 为 …/v1/image_generation，宽高比合法',
    2049:
      'API Key 无效或与站点不匹配：请确认密钥填在生图「API 密钥」（不是对话模型密钥）；国内站 Key 配 api.minimaxi.com，国际站 Key 配 api.minimax.io',
  };
  const hint = hints[statusCode] || '请查阅 MiniMax 开放平台错误码说明';
  const detail = statusMsg.trim() ? `，${statusMsg.trim()}` : '';
  let msg = `MiniMax 生图失败（status_code=${statusCode}${detail}）：${hint}`;
  if (statusCode === 2049 && meta) {
    const bits = [
      meta.host ? `host=${meta.host}` : '',
      meta.authSource ? `鉴权来自 ${meta.authSource}` : '',
      meta.keyHint ? `密钥后缀 ${meta.keyHint}` : '',
    ].filter(Boolean);
    if (bits.length) msg += `（${bits.join('；')}）`;
    if (meta.host && /minimaxi\.com/i.test(meta.host)) {
      msg += '。若 Key 来自国际站 platform.minimax.io，请把 Endpoint 改为 https://api.minimax.io/v1/image_generation';
    } else if (meta.host && /minimax\.io/i.test(meta.host)) {
      msg += '。若 Key 来自国内站 platform.minimaxi.com，请把 Endpoint 改为 https://api.minimaxi.com/v1/image_generation';
    }
  }
  return msg;
}

function looksLikeMiniMaxResponseJson(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return Object.prototype.hasOwnProperty.call(data, 'base_resp');
}

function alternateMiniMaxImageEndpoint(endpoint: string): string | null {
  try {
    const u = new URL(endpoint.trim());
    if (/^api\.minimaxi\.com$/i.test(u.hostname)) {
      u.hostname = 'api.minimax.io';
      u.pathname = '/v1/image_generation';
      u.search = '';
      return u.toString().replace(/\/$/, '');
    }
    if (/^api\.minimax\.io$/i.test(u.hostname)) {
      u.hostname = 'api.minimaxi.com';
      u.pathname = '/v1/image_generation';
      u.search = '';
      return u.toString().replace(/\/$/, '');
    }
  } catch {
    /* ignore */
  }
  return null;
}

describe('MiniMax 生图响应契约', () => {
  it('仅有 base_resp 的错误响应应可识别', () => {
    expect(looksLikeMiniMaxResponseJson({ base_resp: { status_code: 2049, status_msg: 'invalid api key' } })).toBe(
      true
    );
  });

  it('错误码文案包含可操作提示', () => {
    const msg = formatMiniMaxStatusError(2049, 'invalid api key', {
      host: 'api.minimaxi.com',
      authSource: '生图「API 密钥」字段',
      keyHint: '…abcd',
    });
    expect(msg).toContain('2049');
    expect(msg).toContain('API Key');
    expect(msg).toContain('minimaxi.com');
    expect(msg).toContain('minimax.io');
    expect(msg).toContain('鉴权来自');
  });

  it('余额不足错误可识别', () => {
    expect(formatMiniMaxStatusError(1008, 'insufficient balance')).toContain('余额不足');
  });

  it('国内/国际站可互切', () => {
    expect(alternateMiniMaxImageEndpoint('https://api.minimaxi.com/v1/image_generation')).toBe(
      'https://api.minimax.io/v1/image_generation'
    );
    expect(alternateMiniMaxImageEndpoint('https://api.minimax.io/v1/image_generation')).toBe(
      'https://api.minimaxi.com/v1/image_generation'
    );
  });
});
