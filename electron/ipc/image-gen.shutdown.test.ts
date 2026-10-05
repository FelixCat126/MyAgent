// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), record: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { on: vi.fn(), handle: (channel: string, handler: (...args: any[]) => any) => state.handlers.set(channel, handler) } }));
vi.mock('./media-workbench', () => ({ getMediaVersionRepository: () => ({ record: state.record }) }));
import { shutdownImageGeneration } from './image-gen';
describe('image generation shutdown barrier', () => {
 it('waits for an actual SIGTERM-resistant CLI child to die, settles queued jobs and rejects new submissions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-image-shutdown-')); let pid = 0;
  try {
    const activeScript = path.join(directory, 'active.cjs'); const queuedScript = path.join(directory, 'queued.cjs'); const pidFile = path.join(directory, 'pid'); const queuedRan = path.join(directory, 'queued-ran');
    await fs.writeFile(activeScript, 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.env.MYAGENT_TEST_PID,String(process.pid));setInterval(()=>{},1000);');
    await fs.writeFile(queuedScript, 'require("node:fs").writeFileSync(process.env.MYAGENT_QUEUED_RAN,"unexpected");');
    const sender = Object.assign(new EventEmitter(), { id: 99, isDestroyed: () => false, send: vi.fn() }); const handler = state.handlers.get('generate-image')!;
    const first = handler({ sender }, { prompt: 'fixture', outputDir: path.join(directory, 'outputs'), streamRequestId: 'active', imageGeneratorConfig: { type: 'cli', command: process.execPath, cliArgLines: activeScript, env: { MYAGENT_TEST_PID: pidFile } } }).then(() => ({ ok: true }), (error: Error) => ({ ok: false, error: error.message }));
    const queued = handler({ sender }, { prompt: 'fixture', outputDir: path.join(directory, 'outputs'), streamRequestId: 'queued', imageGeneratorConfig: { type: 'cli', command: process.execPath, cliArgLines: queuedScript, env: { MYAGENT_QUEUED_RAN: queuedRan } } }).then(() => ({ ok: true }), (error: Error) => ({ ok: false, error: error.message }));
    for (let attempt = 0; attempt < 100 && !(await fs.stat(pidFile).then(() => true).catch(() => false)); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    pid = Number(await fs.readFile(pidFile, 'utf8')); const started = Date.now(); const shutdown = shutdownImageGeneration();
    expect(() => handler({ sender }, { prompt: 'late', streamRequestId: 'late' })).toThrow('正在退出'); await shutdown;
    expect(Date.now() - started).toBeGreaterThan(800); expect(await first).toMatchObject({ ok: false }); expect(await queued).toMatchObject({ ok: false }); expect(() => process.kill(pid, 0)).toThrow();
    expect(await fs.stat(queuedRan).then(() => true).catch(() => false)).toBe(false); expect(sender.listenerCount('destroyed')).toBe(0); expect(state.record).not.toHaveBeenCalled(); expect(shutdownImageGeneration()).toBe(shutdown);
  } finally { if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* Already terminated by the barrier. */ } await fs.rm(directory, { recursive: true, force: true }); }
 }, 8000);
});
