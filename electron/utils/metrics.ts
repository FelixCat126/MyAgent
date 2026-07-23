/**
 * 主进程统一指标采集：被 health 端点消费；也可被远程网关或健康检查器拉取。
 * 指标以单调累计为主，避免拉取时阻塞主循环。
 */

import type { LogLevel } from '../../src/utils/logger.types';

interface Counter {
  total: number;
  /** 最近一次发生时间（epoch ms）；0 表示从未发生 */
  lastAt: number;
}

const counters: Record<string, Counter> = {};
const startMs = Date.now();

export function incCounter(name: string): void {
  const c = counters[name];
  if (c) {
    c.total += 1;
    c.lastAt = Date.now();
  } else {
    counters[name] = { total: 1, lastAt: Date.now() };
  }
}

export function getCounter(name: string): Counter | undefined {
  return counters[name];
}

export function listCounters(): Record<string, Counter> {
  return { ...counters };
}

export function uptimeSec(): number {
  return Math.floor((Date.now() - startMs) / 1000);
}

/** 给 logger 调用方一个 1-行便利：incCounter + emit。 */
export function metricCounterNames(): string[] {
  return Object.keys(counters);
}

/** 公共类型：log 计数级别；health 端点直接复用 */
export type { LogLevel };