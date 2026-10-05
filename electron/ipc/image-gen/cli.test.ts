// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { generateImageCli } from './cli';
import { imageTaskContext } from './task';
import { readImageSizeWithFallback } from './buffers';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-cli-image-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
async function script(source: string) { const target = path.join(directory, 'generator.cjs'); await fs.writeFile(target, source); return target; }
const params = () => ({ prompt: 'synthetic fixture', outputDir: path.join(directory, 'outputs'), width: 512, height: 512 });
describe('real local CLI image output validation', () => {
 it('executes a real child process and reports decoded dimensions instead of the requested fallback size', async () => {
  const program = await script('require("node:fs").writeFileSync(process.env.MYAGENT_OUTPUT_PATH, Buffer.from(process.env.MYAGENT_TEST_PNG,"base64"));');
  const canvas = createCanvas(5, 7); canvas.getContext('2d').fillRect(0, 0, 5, 7);
  const images = await generateImageCli(params(), { type: 'cli', command: process.execPath, cliArgLines: program, env: { MYAGENT_TEST_PNG: canvas.toBuffer('image/png').toString('base64') } });
  expect(images).toHaveLength(1); expect(images[0]).toMatchObject({ width: 5, height: 7 }); expect((await fs.stat(images[0].path)).size).toBeGreaterThan(0);
 });
 it.each([['empty', 'Buffer.alloc(0)', /为空/], ['text', '"not an image"', /不可解码|不是可解码/]])('rejects %s output without hanging and removes the invalid generated file', async (_kind, value, message) => {
  const program = await script(`require("node:fs").writeFileSync(process.env.MYAGENT_OUTPUT_PATH, ${value});`);
  await expect(generateImageCli(params(), { type: 'cli', command: process.execPath, cliArgLines: program })).rejects.toThrow(message);
  expect(await fs.readdir(params().outputDir)).toEqual([]);
 }, 5000);
 it('cancels a real child that ignores SIGTERM, forces it to stop and settles the operation', async () => {
  const pidFile = path.join(directory, 'pid'); const program = await script('process.on("SIGTERM",()=>{}); require("node:fs").writeFileSync(process.env.MYAGENT_TEST_PID,String(process.pid)); setInterval(()=>{},1000);');
  const controller = new AbortController(); const pending = imageTaskContext.run(controller.signal, () => generateImageCli(params(), { type: 'cli', command: process.execPath, cliArgLines: program, env: { MYAGENT_TEST_PID: pidFile } }));
  for (let attempt = 0; attempt < 100 && !(await fs.stat(pidFile).then(() => true).catch(() => false)); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const pid = Number(await fs.readFile(pidFile, 'utf8')); const assertion = expect(pending).rejects.toThrow('fixture cancelled'); controller.abort(new Error('fixture cancelled')); await assertion;
  expect(() => process.kill(pid, 0)).toThrow(); expect(await fs.readdir(params().outputDir)).toEqual([]);
 }, 8000);
 it('enforces file size and pixel bounds before native decoding', async () => {
  const oversized = path.join(directory, 'too-large.png'); await fs.writeFile(oversized, Buffer.alloc(25 * 1024 * 1024 + 1)); await expect(readImageSizeWithFallback(oversized, params())).rejects.toThrow('25MB');
  const png = createCanvas(1, 1).toBuffer('image/png'); png.writeUInt32BE(10_000, 16); png.writeUInt32BE(10_000, 20); const hugePixels = path.join(directory, 'too-many-pixels.png'); await fs.writeFile(hugePixels, png); await expect(readImageSizeWithFallback(hugePixels, params())).rejects.toThrow('1600');
 });
});
