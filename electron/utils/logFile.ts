/**
 * 主进程日志落盘：按日切分，保留近 14 天。
 * 单进程写入 + append-only；崩溃时丢一段也无所谓（关键事件已带 requestId 可串）。
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const KEEP_DAYS = 14;

function dayString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** 懒求值：app.getPath 在 ready 前会抛，所以首次写日志时才拿路径。 */
let _logDir: string | null = null;
function logDir(): string {
  if (_logDir) return _logDir;
  const dir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _logDir = dir;
  return dir;
}

function currentLogPath(): string {
  return path.join(logDir(), `${dayString()}.log`);
}

let stream: fs.WriteStream | null = null;
let streamPath: string | null = null;

function ensureStream(): fs.WriteStream {
  const p = currentLogPath();
  if (stream && streamPath === p) return stream;
  if (stream) stream.end();
  stream = fs.createWriteStream(p, { flags: 'a', encoding: 'utf-8' });
  streamPath = p;
  return stream;
}

export function writeLogLine(line: string): void {
  try {
    ensureStream().write(line);
  } catch {
    /* 日志写入失败不应阻塞主流程 */
  }
}

let lastCleanup = 0;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 启动时 + 每 6 小时清理一次超过 14 天的日志文件 */
export function cleanupOldLogs(now = Date.now()): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  try {
    const dir = logDir();
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f));
    const cutoffMs = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const f of files) {
      const t = Date.parse(f.slice(0, 10));
      if (!Number.isFinite(t)) continue;
      if (t < cutoffMs) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* 文件可能被并发占用，跳过 */
        }
      }
    }
  } catch {
    /* 目录不存在等情况 */
  }
}