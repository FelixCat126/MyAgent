// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';
import { applyCliPlaceholders, assertSafeShellArgLines, quoteCmdArg } from './cli';
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { on: vi.fn(), handle: (channel: string, handler: (...args: any[]) => any) => state.handlers.set(channel, handler) } }));
vi.mock('../media-workbench', () => ({ getMediaVersionRepository: () => ({ record: vi.fn() }) }));
await import('../image-gen');
const directories: string[] = []; const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve())))); await Promise.all(directories.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
const png = () => { const canvas = createCanvas(4, 4); canvas.getContext('2d').fillRect(0, 0, 4, 4); return canvas.toBuffer('image/png').toString('base64'); };
async function serve(reply: (n: number, round: number) => { status?: number; body: unknown }) {
  const requests: number[] = [];
  const server = http.createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part)); const n = Number(JSON.parse(Buffer.concat(chunks).toString('utf8')).n ?? 1); requests.push(n); const r = reply(n, requests.length); response.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(r.body)); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/images/generations` };
}
async function generate(endpoint: string, count: number, requestId: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-billing-')); directories.push(directory);
  const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, send: vi.fn() });
  return state.handlers.get('generate-image')!({ sender }, { prompt: 'cat', count, streamRequestId: requestId, outputDir: directory, imageGeneratorConfig: { type: 'http', endpoint, provider: 'openai-images', model: 'gpt-image-1', apiKey: 'fixture-key' } });
}
describe('OpenAI Images multi-image billing', () => {
 it('keeps every b64_json image from one response instead of paying for extra rounds', async () => {
  const { requests, endpoint } = await serve(n => ({ body: { data: Array.from({ length: n }, () => ({ b64_json: png() })) } }));
  const images = await generate(endpoint, 4, 'all-in-one');
  expect(images).toHaveLength(4); expect(requests).toEqual([4]);
 });
 it('stops when a fixed-count vendor returns fewer images, and keeps finished images when a later round fails', async () => {
  const fewer = await serve(() => ({ body: { data: [{ b64_json: png() }, { b64_json: png() }] } }));
  expect(await generate(fewer.endpoint, 4, 'fewer')).toHaveLength(2); expect(fewer.requests).toEqual([4]);
  const partial = await serve((n, round) => round === 1 ? { body: { data: Array.from({ length: n }, () => ({ b64_json: png() })) } } : { status: 500, body: { error: { message: 'upstream down' } } });
  expect(await generate(partial.endpoint, 12, 'partial')).toHaveLength(10); expect(partial.requests).toEqual([10, 2]);
 }, 15000);
});
describe('CLI placeholder safety', () => {
 it('does not interpret $ replacement patterns or expand placeholders inside the prompt', () => {
  expect(applyCliPlaceholders('--prompt={{prompt}}', { prompt: 'price $& tax {{outputPath}}' }, '/out.png')).toBe('--prompt=price $& tax {{outputPath}}');
 });
 it('rejects {{prompt}} in cmd.exe arguments and quotes shell metacharacters', () => {
  expect(() => assertSafeShellArgLines(['--prompt', '{{prompt}}'])).toThrow('MYAGENT_PROMPT');
  expect(() => assertSafeShellArgLines(['--out', '{{outputPath}}'])).not.toThrow();
  expect(quoteCmdArg('C:\\My Files\\a&b.png')).toBe('"C:\\My Files\\a&b.png"');
  expect(quoteCmdArg('512')).toBe('512');
 });
});
