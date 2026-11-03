// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));

type LogHandle = Awaited<ReturnType<typeof fs.promises.open>>;
const nativeOpen = fs.promises.open.bind(fs.promises);
const FILE_LIMIT = 5 * 1024 * 1024;
const LINE_LIMIT = 64 * 1024;
const opened: LogHandle[] = [];
let fixture = '';
let dir = '';
let log: typeof import('./logFile');
let openSpy: MockInstance<typeof fs.promises.open>;
const today = () => new Date().toISOString().slice(0, 10);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeHandle() {
  return {
    stat: vi.fn(async () => ({ size: 0, isFile: (): boolean => true })),
    truncate: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    write: vi.fn(async (_data: Buffer, _offset: number, length: number) => ({ bytesWritten: length })),
  };
}

async function sparse(name: string, size: number): Promise<void> {
  const file = await nativeOpen(path.join(dir, name), 'w');
  try { await file.truncate(size); }
  finally { await file.close(); }
}

beforeEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myagent-log-file-'));
  state.userData = fixture;
  dir = path.join(fixture, 'logs');
  await fs.promises.mkdir(dir);
  openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    const result = await nativeOpen(file, flags, mode);
    opened.push(result);
    return result;
  });
  log = await import('./logFile');
});

afterEach(async () => {
  vi.useRealTimers();
  for (const file of opened.splice(0)) await file.close().catch(() => {});
  vi.restoreAllMocks();
  await fs.promises.rm(fixture, { recursive: true, force: true });
});

describe('bounded file logging', () => {
  it('appends in order and flushes the asynchronous writes', async () => {
    log.writeLogLine('first\n');
    log.writeLogLine('second\n');
    await log.flushLogStream();
    expect(await fs.promises.readFile(path.join(dir, `${today()}.log`), 'utf8')).toBe('first\nsecond\n');
  });

  it('catches a real asynchronous open failure and permanently stops retrying', async () => {
    const file = path.join(dir, `${today()}.log`);
    await fs.promises.mkdir(file);
    log.writeLogLine('cannot write to a directory\n');
    await expect(log.flushLogStream()).resolves.toBeUndefined();
    expect(openSpy).toHaveBeenCalledTimes(1);
    await fs.promises.rmdir(file);
    log.writeLogLine('must not reopen\n');
    await log.flushLogStream();
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('catches an asynchronous EIO write rejection and unblocks every flush', async () => {
    const file = fakeHandle();
    let rejectWrite!: (reason: Error) => void;
    file.write.mockImplementation(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
    openSpy.mockResolvedValue(file as unknown as LogHandle);
    log.writeLogLine('initial\n');
    await vi.waitFor(() => expect(file.write).toHaveBeenCalledTimes(1));
    const flush = log.flushLogStream();
    rejectWrite(Object.assign(new Error('write EIO'), { code: 'EIO' }));
    await expect(flush).resolves.toBeUndefined();
    log.writeLogLine('no retries\n');
    await log.flushLogStream();
    expect(file.write).toHaveBeenCalledTimes(1);
    expect(file.close).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('rotates before crossing 5 MiB and keeps only three bounded backups', async () => {
    const day = today();
    await sparse(`${day}.log`, FILE_LIMIT);
    for (const index of [1, 2, 3, 4]) await fs.promises.writeFile(path.join(dir, `${day}.${index}.log`), `backup ${index}\n`);
    log.writeLogLine('new current\n');
    await log.flushLogStream();
    expect((await fs.promises.readdir(dir)).sort()).toEqual([
      `${day}.1.log`, `${day}.2.log`, `${day}.3.log`, `${day}.log`,
    ]);
    expect(await fs.promises.readFile(path.join(dir, `${day}.log`), 'utf8')).toBe('new current\n');
    expect((await fs.promises.stat(path.join(dir, `${day}.1.log`))).size).toBe(FILE_LIMIT);
    expect(await fs.promises.readFile(path.join(dir, `${day}.2.log`), 'utf8')).toBe('backup 1\n');
    expect(await fs.promises.readFile(path.join(dir, `${day}.3.log`), 'utf8')).toBe('backup 2\n');
    for (const name of await fs.promises.readdir(dir)) expect((await fs.promises.stat(path.join(dir, name))).size).toBeLessThanOrEqual(FILE_LIMIT);
  });

  it('truncates a pre-existing giant file without reading it or retaining a giant backup', async () => {
    const day = today();
    await sparse(`${day}.log`, 1024 * 1024 * 1024);
    await sparse(`${day}.2.log`, 1024 * 1024 * 1024);
    await fs.promises.writeFile(path.join(dir, `${day}.1.log`), 'small backup\n');
    const read = vi.spyOn(fs.promises, 'readFile');
    log.writeLogLine('recovered\n');
    await log.flushLogStream();
    expect(read).not.toHaveBeenCalled();
    expect((await fs.promises.stat(path.join(dir, `${day}.log`))).size).toBe(Buffer.byteLength('recovered\n'));
    expect(fs.existsSync(path.join(dir, `${day}.2.log`))).toBe(false);
    expect(await fs.promises.readFile(path.join(dir, `${day}.1.log`), 'utf8')).toBe('small backup\n');
  });

  it('bounds giant UTF-8 lines without splitting a character, including at rotation', async () => {
    const day = today();
    await sparse(`${day}.log`, FILE_LIMIT - 100);
    log.writeLogLine('😀中文'.repeat(50000));
    await log.flushLogStream();
    const data = await fs.promises.readFile(path.join(dir, `${day}.log`));
    const text = data.toString('utf8');
    expect(data.length).toBeLessThanOrEqual(LINE_LIMIT);
    expect(text).not.toContain('\ufffd');
    expect(text).toMatch(/^😀中文/);
    expect(text).toContain('[log truncated]\n');
    expect((await fs.promises.stat(path.join(dir, `${day}.1.log`))).size).toBe(FILE_LIMIT - 100);
  });

  it('allows one in-flight write and at most 256 KiB queued while the disk is slow', async () => {
    const file = fakeHandle();
    const complete: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    file.write.mockImplementation(async (_data, _offset, length) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => complete.push(resolve));
      active--;
      return { bytesWritten: length };
    });
    openSpy.mockResolvedValue(file as unknown as LogHandle);
    for (let index = 0; index < 40; index++) log.writeLogLine('x'.repeat(LINE_LIMIT));
    await vi.waitFor(() => expect(file.write).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 5; index++) {
      expect(complete).toHaveLength(1);
      complete.shift()!();
      await tick();
    }
    await log.flushLogStream();
    expect(file.write).toHaveBeenCalledTimes(5);
    expect(peak).toBe(1);
  });

  it('advances partial writes and disables a writer that makes no progress', async () => {
    const file = fakeHandle();
    file.write.mockImplementation(async (_data, _offset, length) => ({ bytesWritten: Math.min(3, length) }));
    openSpy.mockResolvedValue(file as unknown as LogHandle);
    log.writeLogLine('abcdef\n');
    await log.flushLogStream();
    expect(file.write.mock.calls.map((call) => call[1])).toEqual([0, 3, 6]);
    file.write.mockResolvedValue({ bytesWritten: 0 });
    log.writeLogLine('failed\n');
    await log.flushLogStream();
    expect(file.close).toHaveBeenCalledTimes(1);
    log.writeLogLine('no more writes\n');
    expect(file.write).toHaveBeenCalledTimes(4);
  });

  it('coalesces flushes and times out a hung write without retaining pending writes', async () => {
    const file = fakeHandle();
    let completeWrite!: (result: { bytesWritten: number }) => void;
    file.write.mockImplementation(() => new Promise((resolve) => { completeWrite = resolve; }));
    openSpy.mockResolvedValue(file as unknown as LogHandle);
    log.writeLogLine('stuck\n');
    log.writeLogLine('queued\n');
    await vi.waitFor(() => expect(file.write).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = log.flushLogStream();
    expect(log.flushLogStream()).toBe(first);
    await vi.advanceTimersByTimeAsync(2001);
    await expect(first).resolves.toBeUndefined();
    completeWrite({ bytesWritten: 6 });
    await tick();
    log.writeLogLine('no retry\n');
    await log.flushLogStream();
    expect(file.write).toHaveBeenCalledTimes(1);
    expect(file.close).toHaveBeenCalledTimes(1);
  });

  it('closes an open handle that arrives after flush timeout without writing', async () => {
    const file = fakeHandle();
    let completeOpen!: (value: LogHandle) => void;
    openSpy.mockImplementation(() => new Promise((resolve) => { completeOpen = resolve; }));
    log.writeLogLine('pending open\n');
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flush = log.flushLogStream();
    await vi.advanceTimersByTimeAsync(2001);
    await flush;
    completeOpen(file as unknown as LogHandle);
    await tick();
    expect(file.close).toHaveBeenCalledTimes(1);
    expect(file.stat).not.toHaveBeenCalled();
    expect(file.write).not.toHaveBeenCalled();
  });

  it('closes a handle when stat completes after flush timeout', async () => {
    const file = fakeHandle();
    let completeStat!: (result: { size: number; isFile: () => boolean }) => void;
    file.stat.mockImplementation(() => new Promise((resolve) => { completeStat = resolve; }));
    openSpy.mockResolvedValue(file as unknown as LogHandle);
    log.writeLogLine('pending stat\n');
    await vi.waitFor(() => expect(file.stat).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flush = log.flushLogStream();
    await vi.advanceTimersByTimeAsync(2001);
    await flush;
    completeStat({ size: 0, isFile: () => true });
    await tick();
    expect(file.close).toHaveBeenCalledTimes(1);
    expect(file.write).not.toHaveBeenCalled();
  });

  it('reads current logs and numbered backups in newest-first order', async () => {
    const names = ['2026-11-03.log', '2026-11-03.1.log', '2026-11-03.2.log', '2026-11-02.log'];
    for (const name of [...names, '2026-11-03.4.log', 'other.txt']) await fs.promises.writeFile(path.join(dir, name), `${name}\n`);
    expect((await log.readRecentLogs({ maxFiles: 10 })).map((entry) => entry.name)).toEqual(names);
    expect((await log.readRecentLogs({ maxFiles: 3 })).map((entry) => entry.name)).toEqual(names.slice(0, 3));
  });

  it('reads only a bounded tail and drops the partial UTF-8 first line', async () => {
    await fs.promises.writeFile(path.join(dir, '2026-11-03.log'), `${'😀'.repeat(10000)}\n末尾日志😀\n`);
    await fs.promises.writeFile(path.join(dir, '2026-11-03.1.log'), '中'.repeat(10000));
    const read = vi.spyOn(fs.promises, 'readFile');
    const result = await log.readRecentLogs({ maxFiles: 2, maxBytesEach: 1024 });
    expect(read).not.toHaveBeenCalled();
    expect(result.map((entry) => entry.content)).toEqual(['末尾日志😀\n', '']);
  });

  it('cleans old dates, excess backups and oversized files while preserving fourteen days', async () => {
    const keep = ['2026-11-03.log', '2026-11-03.1.log', '2026-10-21.log', 'unrelated.txt'];
    const remove = ['2026-10-20.log', '2026-10-20.1.log', '2026-11-03.4.log'];
    for (const name of [...keep, ...remove]) await fs.promises.writeFile(path.join(dir, name), 'log\n');
    await sparse('2026-11-03.2.log', FILE_LIMIT + 1);
    log.cleanupOldLogs(Date.UTC(2026, 10, 3, 12));
    expect((await fs.promises.readdir(dir)).sort()).toEqual(keep.sort());
    expect(log.LOG_CLEANUP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });
});
