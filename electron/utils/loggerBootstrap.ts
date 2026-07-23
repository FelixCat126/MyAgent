/**
 * 日志 + 健康 IPC：让渲染端把日志喂给主进程统一落盘；同时暴露 app:get-health 给远程网关。
 */

import { ipcMain, app } from 'electron';
import { rootLogger, rendererRootLogger, type LogLevel } from './logger';
import { getRequestId } from './requestId';
import { writeLogLine, cleanupOldLogs } from './logFile';
import { incCounter, listCounters, uptimeSec } from './metrics';

const PKG_VERSION = '0.0.0'; // 实际值在 bootstrap 时由调用方注入

/**
 * 渲染端 IPC：log payload 转给主进程 rootLogger，自动带上 renderer 当前 requestId
 * （通过 setRequestId 注入），确保主+渲染日志在同一根时间线。
 */
function registerLoggingIpc(): void {
  ipcMain.handle(
    'app:log',
    (_e, payload: { level: LogLevel; msg: string; fields?: Record<string, unknown> }) => {
      try {
        const reqId = getRequestId();
        const fields: Record<string, unknown> = { ...(payload.fields ?? {}), source: 'renderer' };
        if (reqId) fields.requestId = reqId;
        rootLogger[payload.level](payload.msg, fields);
        if (payload.level === 'warn') incCounter('ipc.log.warn');
        else if (payload.level === 'error') incCounter('ipc.log.error');
      } catch (e) {
        rootLogger.error('logger IPC failed', { err: String(e) });
      }
    }
  );
  cleanupOldLogs();
}

export interface HealthSnapshot {
  version: string;
  uptimeSec: number;
  totalLogLines: number;
  counters: Record<string, { total: number; lastAt: number }>;
}

function getHealthSnapshot(version: string): HealthSnapshot {
  const all = listCounters();
  const ipcLog = all['ipc.log'] as { total: number; lastAt: number } | undefined;
  return {
    version,
    uptimeSec: uptimeSec(),
    totalLogLines: ipcLog?.total ?? 0,
    counters: all,
  };
}

function registerHealthIpc(version: string): void {
  ipcMain.handle('app:get-health', () => getHealthSnapshot(version));
  ipcMain.handle('app:get-stats', () => listCounters());
}

/**
 * 主进程一次性引导：把文件落盘挂入 rootLogger，暴露 IPC。
 * 调用方：electron/main.ts 的 app.whenReady 早期。
 */
export function bootstrapLogging(version: string = PKG_VERSION): void {
  /** stdout + 文件双写；rootLogger 已默认 stdout，这里追加文件 */
  rootLogger.addWriter((line) => {
    try {
      writeLogLine(line);
    } catch {
      /* ignore */
    }
  });
  /** 渲染端默认 console（jsdom / dev 态），生产包未触发 */
  void rendererRootLogger;

  registerLoggingIpc();
  registerHealthIpc(version);
  rootLogger.info('logger booted', { version, app: app.getName() });
}