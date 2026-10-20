import crypto from 'crypto';
import type { IncomingMessage } from 'http';

/** Bearer 令牌校验：恒定时间比较，避免理论上的时序侧信道 */
export function authorize(req: IncomingMessage, token: string): boolean {
  const auth = (req.headers.authorization || '').trim();
  const a = Buffer.from(auth, 'utf-8');
  const b = Buffer.from(`Bearer ${token}`, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 按来源 IP 统计令牌校验失败：窗口内失败过多即临时封禁，抑制局域网内暴力猜测 */
export function createAuthFailureLimiter(opts?: { maxFailures?: number; windowMs?: number; blockMs?: number; maxTracked?: number }) {
  const maxFailures = opts?.maxFailures ?? 10;
  const windowMs = opts?.windowMs ?? 10 * 60_000;
  const blockMs = opts?.blockMs ?? 15 * 60_000;
  const maxTracked = opts?.maxTracked ?? 1000;
  const entries = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();
  return {
    isBlocked(ip: string, now = Date.now()): boolean {
      const e = entries.get(ip);
      return Boolean(e && e.blockedUntil > now);
    },
    recordFailure(ip: string, now = Date.now()): void {
      let e = entries.get(ip);
      if (!e || (now - e.firstAt > windowMs && e.blockedUntil <= now)) {
        if (!e && entries.size >= maxTracked) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        e = { count: 0, firstAt: now, blockedUntil: 0 };
        entries.set(ip, e);
      }
      e.count += 1;
      if (e.count >= maxFailures) e.blockedUntil = now + blockMs;
    },
    recordSuccess(ip: string): void {
      entries.delete(ip);
    },
  };
}
