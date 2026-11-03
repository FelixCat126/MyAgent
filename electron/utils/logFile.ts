/**
 * 主进程日志：单文件最多 5 MiB，每天保留当前文件和 3 个备份，保留近 14 天。
 * 串行异步写入，有界排队；通道失败后静默停用，绝不再次调用 logger / stdout。
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const KEEP_DAYS = 14;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BACKUPS = 3;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const FLUSH_TIMEOUT_MS = 2000;
export const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOG_NAME = /^(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d*))?\.log$/;

function dayString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

let _logDir: string | null = null;
function logDir(): string {
  if (_logDir) return _logDir;
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  _logDir = dir;
  return dir;
}

type LogHandle = Awaited<ReturnType<typeof fs.promises.open>>;
let handle: LogHandle | null = null;
let handleDay = '';
let fileBytes = 0;
let disabled = false;
let draining = false;
let pendingBytes = 0;
const pending: Array<{ day: string; data: Buffer }> = [];
let flushing: { promise: Promise<void>; resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

function finishFlush(): void {
  const current = flushing;
  flushing = null;
  if (current) {
    clearTimeout(current.timer);
    current.resolve();
  }
}

async function closeHandle(): Promise<void> {
  const current = handle;
  handle = null;
  if (current) await current.close();
}

function disableFileLogging(): void {
  disabled = true;
  pending.length = 0;
  pendingBytes = 0;
  finishFlush();
  void closeHandle().catch(() => { /* 日志通道失败不能再记录日志。 */ });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function removeIfPresent(file: string): Promise<void> {
  try { await fs.promises.unlink(file); }
  catch (error) { if (!isMissing(error)) throw error; }
}

async function pruneBackups(day: string): Promise<void> {
  const dir = logDir();
  for (const name of await fs.promises.readdir(dir)) {
    const match = LOG_NAME.exec(name);
    if (!match || match[1] !== day || !match[2]) continue;
    const file = path.join(dir, name);
    try {
      if (Number(match[2]) > MAX_BACKUPS || (await fs.promises.stat(file)).size > MAX_FILE_BYTES) {
        await removeIfPresent(file);
      }
    } catch (error) { if (!isMissing(error)) throw error; }
  }
}

async function openHandle(day: string): Promise<LogHandle | null> {
  // 打开/查询期间也可能发生 flush 超时；迟到的句柄必须关闭，不能重新启用通道。
  const candidate = await fs.promises.open(path.join(logDir(), `${day}.log`), 'a');
  let accepted = false;
  try {
    if (disabled) return null;
    let size = (await candidate.stat()).size;
    if (disabled) return null;
    if (size > MAX_FILE_BYTES) {
      // 旧版本留下的巨型文件直接截断，不能把它重命名成同样巨大的备份。
      await candidate.truncate(0);
      size = 0;
    }
    if (disabled) return null;
    handle = candidate;
    handleDay = day;
    fileBytes = size;
    accepted = true;
    return candidate;
  } finally {
    if (!accepted) await candidate.close().catch(() => { /* 静默关闭。 */ });
  }
}

async function ensureHandle(day: string): Promise<LogHandle | null> {
  if (handle && handleDay === day) return handle;
  await closeHandle();
  if (disabled) return null;
  await pruneBackups(day);
  if (disabled) return null;
  return openHandle(day);
}

async function rotate(day: string): Promise<LogHandle | null> {
  await closeHandle();
  if (disabled) return null;
  const dir = logDir();
  await removeIfPresent(path.join(dir, `${day}.${MAX_BACKUPS}.log`));
  for (let index = MAX_BACKUPS - 1; index >= 0; index--) {
    if (disabled) return null;
    const from = path.join(dir, index === 0 ? `${day}.log` : `${day}.${index}.log`);
    const to = path.join(dir, `${day}.${index + 1}.log`);
    try { await fs.promises.rename(from, to); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  if (disabled) return null;
  return openHandle(day);
}

/** 编码前先限制字符数，避免为巨型字段临时分配同样巨大的 Buffer。 */
function boundedLine(line: string): Buffer {
  let prefix = line.slice(0, MAX_LINE_BYTES);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (prefix.length < line.length && last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  const data = Buffer.from(prefix, 'utf8');
  if (prefix.length === line.length && data.length <= MAX_LINE_BYTES) return data;
  const marker = Buffer.from(' [log truncated]\n');
  let end = Math.min(data.length, MAX_LINE_BYTES - marker.length);
  while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
  return Buffer.concat([data.subarray(0, end), marker]);
}

async function drainPending(): Promise<void> {
  if (draining || disabled) return;
  draining = true;
  try {
    while (pending.length && !disabled) {
      const entry = pending.shift()!;
      pendingBytes -= entry.data.length;
      let current = await ensureHandle(entry.day);
      if (!current || disabled) break;
      if (fileBytes + entry.data.length > MAX_FILE_BYTES) current = await rotate(entry.day);
      if (!current || disabled) break;
      // FileHandle.write 的 promise 提供背压；处理部分写入，不叠加未完成的 IO。
      let offset = 0;
      while (offset < entry.data.length && !disabled) {
        const result = await current.write(entry.data, offset, entry.data.length - offset, null);
        if (result.bytesWritten <= 0) throw new Error('Log write made no progress');
        offset += result.bytesWritten;
        fileBytes += result.bytesWritten;
      }
    }
  } catch {
    disableFileLogging();
  } finally {
    draining = false;
    if (!pending.length || disabled) finishFlush();
  }
}

export function writeLogLine(line: string): void {
  if (disabled) return;
  try {
    const data = boundedLine(line);
    if (!data.length || pendingBytes + data.length > MAX_PENDING_BYTES) return;
    pending.push({ day: dayString(), data });
    pendingBytes += data.length;
    void drainPending();
  } catch {
    disableFileLogging();
  }
}

/** 所有并发 flush 共用一个等待，出错或超时立即完成，通道不再重试。 */
export function flushLogStream(): Promise<void> {
  if (disabled || (!draining && !pending.length)) return Promise.resolve();
  if (!flushing) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const timer = setTimeout(disableFileLogging, FLUSH_TIMEOUT_MS);
    flushing = { promise, resolve, timer };
  }
  return flushing.promise;
}

/** 支持包读取最新文件及轮转备份；仅定位读取尾部，丢弃不完整的首行。 */
export async function readRecentLogs(options: { maxFiles?: number; maxBytesEach?: number } = {}): Promise<Array<{ name: string; content: string }>> {
  await flushLogStream();
  const maxFiles = Math.max(1, Math.min(10, options.maxFiles ?? 3));
  const maxBytes = Math.max(1024, Math.min(1024 * 1024, options.maxBytesEach ?? 512 * 1024));
  const names = (await fs.promises.readdir(logDir()))
    .map((name) => ({ name, match: LOG_NAME.exec(name) }))
    .filter((entry) => entry.match && Number(entry.match[2] ?? 0) <= MAX_BACKUPS)
    .sort((a, b) => b.match![1].localeCompare(a.match![1]) || Number(a.match![2] ?? 0) - Number(b.match![2] ?? 0));
  const output: Array<{ name: string; content: string }> = [];
  for (const { name } of names) {
    if (output.length >= maxFiles) break;
    let file: LogHandle | undefined;
    try {
      file = await fs.promises.open(path.join(logDir(), name), 'r');
      const stat = await file.stat();
      if (!stat.isFile()) continue;
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      const start = Math.max(0, stat.size - length);
      let offset = 0;
      while (offset < length) {
        const result = await file.read(buffer, offset, length - offset, start + offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const bytes = buffer.subarray(0, offset);
      const newline = start > 0 ? bytes.indexOf(10) : -1;
      const content = start > 0 ? (newline >= 0 ? bytes.subarray(newline + 1).toString('utf8') : '') : bytes.toString('utf8');
      output.push({ name, content });
    } catch (error) {
      // 清理/轮转可能恰好移走文件；继续尝试下一份日志。
      if (!isMissing(error)) throw error;
    } finally { await file?.close(); }
  }
  return output;
}

let lastCleanup = 0;

/** 由 bootstrap 启动时及周期调用；旧日、额外备份和旧版巨型文件都不保留。 */
export function cleanupOldLogs(now = Date.now()): void {
  if (lastCleanup && now - lastCleanup < LOG_CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  try {
    const dir = logDir();
    const cutoffMs = Date.parse(dayString(new Date(now))) - (KEEP_DAYS - 1) * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const match = LOG_NAME.exec(name);
      if (!match) continue;
      const file = path.join(dir, name);
      try {
        const day = Date.parse(match[1]);
        if (!Number.isFinite(day)) continue;
        if (day < cutoffMs || Number(match[2] ?? 0) > MAX_BACKUPS || fs.statSync(file).size > MAX_FILE_BYTES) {
          fs.unlinkSync(file);
        }
      } catch { /* 清理失败不影响业务，也不能再写日志。 */ }
    }
  } catch { /* 目录暂不可用。 */ }
}
