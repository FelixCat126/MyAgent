// @vitest-environment node
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createSafeStreamWriter } from './safeStreamWriter';

const eio = () => Object.assign(new Error('write EIO'), { code: 'EIO', syscall: 'write' });
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function fakeStream(write: (...args: unknown[]) => boolean) {
  return Object.assign(new EventEmitter(), { writable: true, write: vi.fn(write) });
}
const writable = (stream: EventEmitter): NodeJS.WritableStream => stream as NodeJS.WritableStream;

describe('safe stream writer', () => {
  it('consumes next-tick Writable EIO and permanently stops that channel', async () => {
    let writes = 0;
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        writes++;
        process.nextTick(() => callback(eio()));
      },
    });
    const write = createSafeStreamWriter(stream);
    write('first\n');
    await nextTurn();
    for (let i = 0; i < 100; i++) write('after failure\n');
    expect(writes).toBe(1);
    expect(() => stream.emit('error', eio())).not.toThrow();
  });

  it('stops after a synchronous throw, including when later drain events arrive', () => {
    const stream = fakeStream(() => { throw eio(); });
    const write = createSafeStreamWriter(writable(stream));
    expect(() => write('first')).not.toThrow();
    stream.emit('drain');
    write('second');
    expect(stream.write).toHaveBeenCalledTimes(1);
  });

  it('stops on callback failure even if the stream never emits error', () => {
    const stream = fakeStream((_line, callback) => {
      (callback as (error: Error) => void)(eio());
      return true;
    });
    const write = createSafeStreamWriter(writable(stream));
    write('first');
    stream.emit('drain');
    write('second');
    expect(stream.write).toHaveBeenCalledTimes(1);
  });

  it('stops on an asynchronous callback failure after drain already resumed the stream', async () => {
    let complete: ((error: Error) => void) | undefined;
    const stream = fakeStream((_line, callback) => {
      complete = callback as (error: Error) => void;
      return false;
    });
    const write = createSafeStreamWriter(writable(stream));
    write('first');
    stream.emit('drain');
    process.nextTick(() => complete!(eio()));
    await nextTurn();
    write('second');
    expect(stream.write).toHaveBeenCalledTimes(1);
  });

  it('consumes an error before the first write and keeps consuming later errors', () => {
    const stream = fakeStream(() => true);
    const write = createSafeStreamWriter(writable(stream));
    expect(() => stream.emit('error', eio())).not.toThrow();
    write('first');
    expect(() => stream.emit('error', eio())).not.toThrow();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it('drops lines under backpressure and resumes only after drain', () => {
    let release: (() => void) | undefined;
    const chunks: string[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        release = callback;
      },
    });
    const write = createSafeStreamWriter(stream);
    write('first');
    for (let i = 0; i < 1000; i++) write('dropped');
    expect(stream.writableLength).toBe(Buffer.byteLength('first'));
    expect(chunks).toEqual(['first']);
    release!();
    write('second');
    expect(chunks).toEqual(['first', 'second']);
    release!();
    stream.destroy();
  });

  it('handles synchronous drain and callback races without staying blocked', () => {
    const stream = fakeStream((_line, callback) => {
      stream.emit('drain');
      (callback as () => void)();
      return false;
    });
    const write = createSafeStreamWriter(writable(stream));
    write('first');
    write('second');
    expect(stream.write).toHaveBeenCalledTimes(2);
  });

  it('does not let synchronous drain undo a callback failure', () => {
    const stream = fakeStream((_line, callback) => {
      (callback as (error: Error) => void)(eio());
      stream.emit('drain');
      return false;
    });
    const write = createSafeStreamWriter(writable(stream));
    write('first');
    write('second');
    expect(stream.write).toHaveBeenCalledTimes(1);
  });

  it.each(['destroyed', 'writableEnded', 'writableFinished', 'closed', 'errored'])(
    'never writes to a stream with %s set', property => {
      const stream = Object.assign(fakeStream(() => true), { [property]: true });
      const write = createSafeStreamWriter(writable(stream));
      write('closed');
      expect(stream.write).not.toHaveBeenCalled();
      expect(() => stream.emit('error', eio())).not.toThrow();
    },
  );

  it('does not write when writable is false', () => {
    const stream = fakeStream(() => true);
    stream.writable = false;
    createSafeStreamWriter(writable(stream))('closed');
    expect(stream.write).not.toHaveBeenCalled();
  });
});
