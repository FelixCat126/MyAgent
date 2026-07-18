/**
 * 持久化敏感字段加解密的纯函数核心（不依赖 electron，可单测）。
 *
 * 设计要点：
 * - 只处理已知敏感键（apiKey / embeddingApiKey / volcAsr*Key / token）与 env 字典值；
 *   其余字段原样保留，爆炸半径限于密钥本身。
 * - 加密值带 ENC_VALUE_PREFIX 前缀；旧明文无前缀 → 读取直通（无缝迁移，下次写入时加密）。
 * - 解密失败（钥匙串 ACL 变更、dev↔DMG 切换等）→ 原样保留密文（无损往返，
 *   换回可解密环境即恢复），且写入端不对已加密值二次加密。
 */

export const ENC_VALUE_PREFIX = 'enc:v1:';

/** 返回 base64 密文 */
export type EncryptString = (plain: string) => string;
/** 入参 base64 密文；失败可抛异常 */
export type DecryptString = (base64: string) => string;

const SENSITIVE_KEYS = new Set([
  'apiKey',
  'embeddingApiKey',
  'volcAsrAppKey',
  'volcAsrAccessKey',
  'token',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function protectEnvDict(env: Record<string, unknown>, encrypt: EncryptString): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] =
      typeof v === 'string' && v.length > 0 && !v.startsWith(ENC_VALUE_PREFIX)
        ? ENC_VALUE_PREFIX + encrypt(v)
        : v;
  }
  return out;
}

function revealEnvDict(env: Record<string, unknown>, decrypt: DecryptString | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === 'string' ? revealSecretString(v, decrypt) : v;
  }
  return out;
}

/** 解密失败时原样保留（无损往返） */
function revealSecretString(v: string, decrypt: DecryptString | null): string {
  if (!v.startsWith(ENC_VALUE_PREFIX)) return v;
  if (!decrypt) return v;
  try {
    return decrypt(v.slice(ENC_VALUE_PREFIX.length));
  } catch {
    return v;
  }
}

/** 写入持久化前：递归加密敏感字段（幂等，已加密值不重复加密） */
export function protectPersistValue(node: unknown, encrypt: EncryptString | null): unknown {
  if (!encrypt || node == null) return node;
  if (Array.isArray(node)) return node.map((v) => protectPersistValue(v, encrypt));
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (SENSITIVE_KEYS.has(k) && typeof v === 'string' && v.length > 0 && !v.startsWith(ENC_VALUE_PREFIX)) {
      out[k] = ENC_VALUE_PREFIX + encrypt(v);
    } else if (k === 'env' && isPlainObject(v)) {
      out[k] = protectEnvDict(v, encrypt);
    } else {
      out[k] = protectPersistValue(v, encrypt);
    }
  }
  return out;
}

/** 读取持久化后：递归还原敏感字段（旧明文直通；解密失败原样保留） */
export function revealPersistValue(node: unknown, decrypt: DecryptString | null): unknown {
  if (node == null) return node;
  if (Array.isArray(node)) return node.map((v) => revealPersistValue(v, decrypt));
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (SENSITIVE_KEYS.has(k) && typeof v === 'string') {
      out[k] = revealSecretString(v, decrypt);
    } else if (k === 'env' && isPlainObject(v)) {
      out[k] = revealEnvDict(v, decrypt);
    } else {
      out[k] = revealPersistValue(v, decrypt);
    }
  }
  return out;
}
