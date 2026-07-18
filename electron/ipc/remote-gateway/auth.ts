import type { IncomingMessage } from 'http';

export function authorize(req: IncomingMessage, _url: URL, token: string): boolean {
  const auth = (req.headers.authorization || '').trim();
  if (auth === `Bearer ${token}`) return true;
  return false;
}