import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeTask, RuntimeSchedule, McpConnection, RuntimeSnapshot, JsonObject, RuntimeStep } from '../../src/features/runtime/api';
export interface RuntimeState extends RuntimeSnapshot { version: 1; allowedDirectories: string[] }
export const emptyState = (): RuntimeState => ({ version: 1, tasks: [], schedules: [], connections: [], allowedDirectories: [] });
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
export class TaskLedger {
  state: RuntimeState = emptyState();
  private writing = Promise.resolve();
  constructor(readonly file: string, private encode: (state: RuntimeState) => RuntimeState = x => x, private decode: (state: RuntimeState) => RuntimeState = x => x) {}
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (raw.version !== 1 || !Array.isArray(raw.tasks) || !Array.isArray(raw.schedules) || !Array.isArray(raw.connections)) throw new Error('任务数据库格式不兼容');
      this.state = this.decode({ ...emptyState(), ...raw });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const task of this.state.tasks) {
      if (task.status === 'running' || task.status === 'awaiting_action') { task.status = 'interrupted'; task.error = '应用退出时任务未完成，可继续已有进度'; task.updatedAt = Date.now(); }
      for (const step of task.steps) if (step.status === 'running') step.status = 'interrupted';
    }
    const now = Date.now();
    for (const schedule of this.state.schedules) if (schedule.enabled && schedule.nextRunAt < now) { schedule.missedAt = schedule.nextRunAt; schedule.enabled = false; schedule.lastError = '应用未运行时错过计划；请手动执行或重新启用'; }
    await this.save();
  }
  async save(): Promise<void> {
    const snapshot = this.encode(JSON.parse(JSON.stringify(this.state)));
    this.writing = this.writing.catch(() => undefined).then(() => atomicJson(this.file, snapshot));
    await this.writing;
  }
  task(id: string): RuntimeTask { const found = this.state.tasks.find(t => t.id === id); if (!found) throw new Error('任务不存在'); return found; }
  async create(input: { title: string; kind: RuntimeTask['kind']; prompt?: string; projectId?: string; checkpoint?: JsonObject; idempotencyKey?: string }): Promise<RuntimeTask> {
    if (!input.title?.trim() || input.title.length > 200 || !['agent','reminder','web-monitor','directory-monitor','image-generation','video-generation','document'].includes(input.kind)) throw new Error('任务名称或类型无效');
    if (input.idempotencyKey) { const found = this.state.tasks.find(t => t.idempotencyKey === input.idempotencyKey); if (found) return found; }
    const now = Date.now();
    const task: RuntimeTask = { ...input, id: randomUUID(), title: input.title.trim(), status: 'queued', steps: [], createdAt: now, updatedAt: now };
    // New work is ordinary work; legacy associations are preserved only when loading old records.
    delete task.projectId;
    this.state.tasks.push(task); await this.save(); return task;
  }
  async start(id: string, retry = false): Promise<RuntimeTask> {
    const task = this.task(id);
    if (task.status === 'running') return task;
    if (retry ? !['failed','interrupted','cancelled'].includes(task.status) : task.status !== 'queued') throw new Error('当前任务不能启动，请使用继续操作');
    task.status = 'running'; task.error = undefined; task.updatedAt = Date.now();
    await this.save(); return task;
  }
  async finish(id: string, result?: unknown, error?: string): Promise<RuntimeTask> {
    const task = this.task(id);
    if (task.status !== 'running' && task.status !== 'awaiting_action') return task;
    task.status = error ? 'failed' : 'completed'; task.error = error; task.result = result; task.updatedAt = Date.now(); await this.save(); return task;
  }
  async interruptActive(): Promise<void> {
    for (const task of this.state.tasks) {
      if (task.status !== 'running' && task.status !== 'awaiting_action') continue;
      task.status = 'interrupted'; task.error = '应用退出时任务未完成，可继续已有进度'; task.updatedAt = Date.now();
      for (const step of task.steps) if (step.status === 'running') step.status = 'interrupted';
    }
    await this.save();
  }
  async cancel(id: string): Promise<RuntimeTask> {
    const task = this.task(id);
    if (task.status === 'completed') throw new Error('已完成任务无需取消');
    task.status = 'cancelled'; task.updatedAt = Date.now(); for (const step of task.steps) if (step.status === 'running') step.status = 'interrupted';
    await this.save(); return task;
  }
  async checkpoint(id: string, checkpoint: JsonObject): Promise<RuntimeTask> {
    const task = this.task(id); if (task.status !== 'running') return task;
    if (Buffer.byteLength(JSON.stringify(checkpoint)) > 16 * 1024 * 1024) throw new Error('任务检查点超过 16 MB');
    task.checkpoint = checkpoint; task.updatedAt = Date.now(); await this.save(); return task;
  }
  /** Persist a late provider receipt after cancellation without reopening the task or issuing another submit. */
  async recoveryCheckpoint(id:string,checkpoint:JsonObject):Promise<RuntimeTask>{
    const task=this.task(id);if(!['image-generation','video-generation'].includes(task.kind))throw new Error('仅媒体任务可记录晚到的服务回执');
    if(Buffer.byteLength(JSON.stringify(checkpoint))>16*1024*1024)throw new Error('服务回执超过 16 MB');
    task.checkpoint={...task.checkpoint,...checkpoint};task.updatedAt=Date.now();await this.save();return task;
  }
  async step(input: { taskId: string; key: string; title: string; status: RuntimeStep['status']; result?: unknown; error?: string }): Promise<RuntimeTask> {
    const task = this.task(input.taskId); if (task.status !== 'running') return task;
    if (!input.key || input.key.length > 500) throw new Error('步骤标识无效');
    const previous = task.steps.find(s => s.key === input.key);
    if (previous?.status === 'completed') return task;
    const step: RuntimeStep = { key: input.key, title: input.title, status: input.status, result: input.result, error: input.error, updatedAt: Date.now() };
    if (previous) Object.assign(previous, step); else task.steps.push(step);
    task.updatedAt = Date.now(); await this.save(); return task;
  }
  async schedule(input: Omit<RuntimeSchedule, 'id'> & { id?: string }): Promise<RuntimeSchedule> {
    if (!['agent','reminder','web-monitor','directory-monitor'].includes(input.kind)) throw new Error('此任务类型不支持定时计划');
    if (!input.title?.trim() || !Number.isFinite(input.nextRunAt) || input.nextRunAt < 0) throw new Error('计划名称或时间无效');
    if (input.intervalMinutes !== undefined && (!Number.isFinite(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 525600)) throw new Error('重复间隔必须为 1 分钟到 1 年');
    if (input.kind === 'web-monitor') { const url = new URL(input.url || ''); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入不带凭证的 HTTP 网页地址'); }
    if (input.kind === 'directory-monitor' && !this.state.allowedDirectories.includes(input.directory || '')) throw new Error('请通过选择目录按钮授权监控目录');
    const old = input.id ? this.state.schedules.find(s => s.id === input.id) : undefined;
    const schedule: RuntimeSchedule = { ...input, title: input.title.trim(), id: old?.id || randomUUID(), missedAt: undefined };
    if (old?.projectId) schedule.projectId = old.projectId;
    else delete schedule.projectId;
    if (old) Object.assign(old, schedule); else this.state.schedules.push(schedule);
    await this.save(); return schedule;
  }
  async connection(input: McpConnection): Promise<McpConnection> {
    if (!input.name?.trim() || !['http','stdio'].includes(input.transport)) throw new Error('连接名称或类型无效');
    const old = this.state.connections.find(c => c.id === input.id);
    const value = { ...input, id: old?.id || randomUUID() };
    if (old) Object.assign(old, value); else this.state.connections.push(value); await this.save(); return value;
  }
}
