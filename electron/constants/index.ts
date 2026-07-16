/**
 * Electron 主进程常量聚合入口。
 *
 * 集中管理跨模块复用的数值字面量，区分语义（超时 vs 字符数 vs 通用限制）。
 * 避免魔法数字散落各文件、避免同字面值跨概念误用。
 */

export * from './timeouts';
export * from './limits';
export * from './imageGenLimits';
