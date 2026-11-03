// @vitest-environment node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { StructuredLogger } from './logger';
import { createSafeStreamWriter } from './safeStreamWriter';

describe('logger output isolation', () => {
  it('continues the file writer after stdout fails asynchronously', async () => {
    let stdoutWrites = 0;
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        stdoutWrites++;
        process.nextTick(() => callback(Object.assign(new Error('write EIO'), { code: 'EIO' })));
      },
    });
    const fileLines: string[] = [];
    const logger = new StructuredLogger('test', {}, { writer: createSafeStreamWriter(stdout) });
    logger.addWriter(line => fileLines.push(line));
    logger.info('first');
    await new Promise<void>(resolve => setImmediate(resolve));
    logger.error('after stdout failure');
    expect(stdoutWrites).toBe(1);
    expect(fileLines.map(line => JSON.parse(line).msg)).toEqual(['first', 'after stdout failure']);
  });

  it('writes valid JSON for BigInt and circular fields', () => {
    const lines: string[] = [];
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const logger = new StructuredLogger('test', {}, { writer: line => lines.push(line) });
    expect(() => logger.error('error details', { count: 1n, circular })).not.toThrow();
    expect(JSON.parse(lines[0])).toMatchObject({
      msg: 'error details', count: '1', circular: { self: '[Circular]' },
    });
  });

  it('continues the file writer while stdout is under backpressure', () => {
    const stdout = new Writable({ highWaterMark: 1, write() { /* keep the first write pending */ } });
    const fileLines: string[] = [];
    const logger = new StructuredLogger('test', {}, { writer: createSafeStreamWriter(stdout) });
    logger.addWriter(line => fileLines.push(line));
    logger.info('first');
    logger.info('second');
    expect(fileLines.map(line => JSON.parse(line).msg)).toEqual(['first', 'second']);
    expect(stdout.writableLength).toBe(Buffer.byteLength(fileLines[0]));
    stdout.destroy();
  });

  it('survives a field with throwing serialization methods', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger('test', {}, { writer: line => lines.push(line) });
    const hostile = { toJSON() { throw new Error('bad toJSON'); }, toString() { throw new Error('bad toString'); } };
    expect(() => logger.error('error details', { hostile })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it('breaks the old uncaughtException feedback loop in a bounded child process', () => {
    const sources = Object.fromEntries(['logger', 'safeStreamWriter'].map(name => [name,
      ts.transpileModule(readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      }).outputText,
    ]));
    const script = `
      const sources = ${JSON.stringify(sources)};
      const modules = {};
      function load(name) {
        if (modules[name]) return modules[name].exports;
        const module = modules[name] = { exports: {} };
        const localRequire = id => id.startsWith('./') ? load(id.slice(2)) : require(id);
        new Function('exports', 'require', 'module', sources[name])(module.exports, localRequire, module);
        return module.exports;
      }
      let writes = 0, uncaught = 0;
      const fileLines = [];
      process.stdout._write = (_chunk, _encoding, callback) => {
        writes++;
        process.nextTick(() => callback(Object.assign(new Error('write EIO'), {code:'EIO'})));
      };
      const { rootLogger } = load('logger');
      rootLogger.addWriter(line => fileLines.push(JSON.parse(line)));
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        require('node:fs').writeSync(2, JSON.stringify({writes,uncaught,fileLines}));
        process.exit(0);
      }
      process.on('uncaughtException', error => {
        if (++uncaught >= 6) return finish();
        rootLogger.fatal('main uncaughtException', {error:error.stack});
      });
      rootLogger.info('initial log');
      setTimeout(() => {
        rootLogger.info('after stdout failure');
        process.stderr.emit('error', Object.assign(new Error('write EIO'), {code:'EIO'}));
        setImmediate(finish);
      }, 20);
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stderr);
    expect(report).toMatchObject({ writes: 1, uncaught: 0 });
    expect(report.fileLines.map((line: { msg: string }) => line.msg)).toEqual([
      'initial log', 'after stdout failure',
    ]);
  });
});
