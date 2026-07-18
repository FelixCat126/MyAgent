import { app, safeStorage } from 'electron';
import {
  protectPersistValue,
  revealPersistValue,
  type DecryptString,
  type EncryptString,
} from './secureFields';

/**
 * safeStorage 绑定层：将纯函数核心接到 Electron 钥匙串加密。
 * persist IPC 在 import 期即注册（app ready 前），故可用性必须运行时惰性判断；
 * Linux 无钥匙串 / ready 前 / 任何异常 → 返回 null，落盘保持明文（与改造前一致，无回归）。
 */
function encryptionAvailable(): boolean {
  try {
    if (!app.isReady()) return false;
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function getPersistEncryptor(): EncryptString | null {
  if (!encryptionAvailable()) return null;
  return (plain) => safeStorage.encryptString(plain).toString('base64');
}

export function getPersistDecryptor(): DecryptString | null {
  if (!encryptionAvailable()) return null;
  return (base64) => safeStorage.decryptString(Buffer.from(base64, 'base64'));
}

/** 写入前：对 persist JSON 文本做敏感字段加密；非 JSON 原样返回 */
export function protectPersistJsonText(raw: string): string {
  try {
    return JSON.stringify(protectPersistValue(JSON.parse(raw), getPersistEncryptor()));
  } catch {
    return raw;
  }
}

/** 读取后：对 persist JSON 文本做敏感字段还原；非 JSON 原样返回 */
export function revealPersistJsonText(raw: string): string {
  try {
    return JSON.stringify(revealPersistValue(JSON.parse(raw), getPersistDecryptor()));
  } catch {
    return raw;
  }
}

/** 主进程内部消费（如远端网关读模型列表）：直接还原已解析对象 */
export function revealPersistParsed(parsed: unknown): unknown {
  try {
    return revealPersistValue(parsed, getPersistDecryptor());
  } catch {
    return parsed;
  }
}

/** 远端网关等独立 JSON 配置文件的加密入口 */
export function protectPersistParsed<T>(parsed: T): T {
  try {
    return protectPersistValue(parsed, getPersistEncryptor()) as T;
  } catch {
    return parsed;
  }
}
