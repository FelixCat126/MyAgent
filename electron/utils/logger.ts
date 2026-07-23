/**
 * 轻量级结构化日志门面。
 *
 * 设计目标：
 * - 主进程与渲染进程可独立使用，结构对称
 * - 支持 child 命名 + 结构化字段（requestId、sessionId 等）
 * - 5 级（debug/info/warn/error/fatal）；dev 态高亮 + 完整字段，prod 态 plain JSON 单行
 * - 主进程额外写到 rotating 文件（按日切分，保留近 14 天），便于事后回溯用户报告的"昨晚出问题了"
 * - 不引入任何 npm 依赖（轻量、可被 main / preload / test 共用）
 *
 * 不做（留 v2）：远程上报、Sentry 集成、日志级别远程开关、敏感字段自动脱敏（业务侧负责）
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export interface LogFields {
  [k: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  /** 创建子 logger：自动继承父级 fields（典型用法：child({requestId}) 后整条链路调用） */
  child(fields: LogFields): Logger;
  /** 追加写入器（主进程启动时把 stdout + 文件落盘叠起来用） */
  addWriter(w: (line: string) => void): void;
}

export interface LoggerOptions {
  /** 最少输出的级别：低于此级别直接丢弃（默认 debug） */
  minLevel?: LogLevel;
  /** dev 态开关：true 输出带 ANSI 颜色 + 完整字段；false 输出 plain JSON 单行 */
  dev?: boolean;
  /** 写入器：单参数字符串；可链式叠加 stdout / 文件 / IPC 转发。 */
  writer?: (line: string) => void;
}

const COLOR = {
  reset: '\u001b[0m',
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  fatal: '\u001b[1;31m',
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export class StructuredLogger implements Logger {
  private readonly minRank: number;
  private readonly dev: boolean;
  private readonly writers: Array<(line: string) => void>;
  private readonly bound: LogFields;
  private readonly name: string;

  constructor(name: string, bound: LogFields, opts: LoggerOptions) {
    this.name = name;
    this.bound = bound;
    this.minRank = LEVEL_RANK[opts.minLevel ?? 'debug'];
    this.dev = opts.dev ?? false;
    this.writers = opts.writer ? [opts.writer] : [(line) => console.log(line)];
  }

  /** 追加一个写入器（主进程启动时把 stdout + 文件落盘叠起来用） */
  addWriter(w: (line: string) => void): void {
    this.writers.push(w);
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const merged: LogFields = { ...this.bound, ...(fields ?? {}) };
    const t = nowIso();
    const base = { t, level, name: this.name, msg, ...merged };
    const line =
      this.dev
        ? `${COLOR[level]}${t} ${level.toUpperCase()} [${this.name}] ${msg}${COLOR.reset}\n${safeStringify(merged)}\n`
        : JSON.stringify(base) + '\n';
    for (const w of this.writers) {
      try {
        w(line);
      } catch {
        /* logger 自身失败不应阻塞主流程 */
      }
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
    return new StructuredLogger(this.name, { ...this.bound, ...fields }, {
      minLevel: this.minLevelName(),
      dev: this.dev,
      writer: this.compositeWriter(),
    });
  }

  private minLevelName(): LogLevel {
    for (const [k, v] of Object.entries(LEVEL_RANK)) {
      if (v === this.minRank) return k as LogLevel;
    }
    return 'debug';
  }

  private compositeWriter(): (line: string) => void {
    const ws = this.writers;
    return (line: string) => {
      for (const w of ws) {
        try {
          w(line);
        } catch {
          /* ignore */
        }
      }
    };
  }
}

/** 主进程根 logger（默认 stdout，开发态 dev=true；文件落盘在 bootstrap 里 addWriter 接入） */
export const rootLogger: Logger = new StructuredLogger('app', {}, {
  dev: true,
  writer: (line) => process.stdout.write(line),
});

/** 渲染进程根 logger（默认纯 console，主进程统一落盘；IPC 转发见 loggerBootstrap） */
export const rendererRootLogger: Logger = new StructuredLogger('renderer', {}, {
  dev: true,
});