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
