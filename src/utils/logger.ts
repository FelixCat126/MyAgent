/**
 * 渲染端结构化日志门面。
 *
 * 主进程统一落盘；本门面把日志通过 IPC 转给主进程 logger，主进程合并时间戳 + 等级后写入文件。
 * 这样所有日志都有同一根时间线，回溯更直观。
 *
 * 浏览器开发态：fallback 到 console（IPC 不可达时），保持开发体验。
 */

import { newId } from './newId';

export type { LogLevel, LogFields, Logger } from './logger.types';
import type { LogFields, LogLevel, Logger } from './logger.types';

let requestIdForThisTurn = '';

export function setRequestId(id: string): void {
  requestIdForThisTurn = id;
}

export function currentRequestId(): string {
  return requestIdForThisTurn;
}

export function newRequestId(): string {
  const id = newId();
  setRequestId(id);
  return id;
}

type ElectronLogChannel = (payload: { level: LogLevel; msg: string; fields?: LogFields }) => void;

function getChannel(): ElectronLogChannel | null {
  if (typeof window === 'undefined') return null;
  const api = (window as { electron?: { log?: ElectronLogChannel } }).electron;
  return api?.log ?? null;
}

class RendererLogger implements Logger {
  private readonly bound: LogFields;

  constructor(bound: LogFields) {
    this.bound = bound;
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    const merged: LogFields = { ...this.bound, ...(fields ?? {}) };
    const channel = getChannel();
    if (channel) {
      try {
        channel({ level, msg, fields: merged });
      } catch {
        /* 主进程通道异常：fallback console */
      }
      return;
    }
    if (typeof console !== 'undefined') {
      const tag = `[renderer:${level}] ${msg}`;
      if (level === 'error' || level === 'fatal') console.error(tag, merged);
      else if (level === 'warn') console.warn(tag, merged);
      else console.log(tag, merged);
    }
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields);
  }
  fatal(msg: string, fields?: LogFields): void {
    this.emit('fatal', msg, fields);
  }
  child(fields: LogFields): Logger {
    return new RendererLogger({ ...this.bound, ...fields });
  }
}

export const rendererLogger: Logger = new RendererLogger({});