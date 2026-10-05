// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { generateImageHttp } from './http';
vi.mock('electron', () => ({ app: { getPath: () => '/unused-fixture' } }));
const directories: string[] = []; const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve())))); await Promise.all(directories.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
describe('HTTP image edit execution', () => {
 it('sends multipart image and transparent mask to edits, then decodes a downloadable real PNG', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-edit-')); directories.push(directory);
  const source = createCanvas(12, 10); const context = source.getContext('2d'); context.fillStyle = 'red'; context.fillRect(0, 0, 12, 10);
  const sourcePath = path.join(directory, 'source.png'); await fs.writeFile(sourcePath, source.toBuffer('image/png')); context.clearRect(0, 0, 4, 4);
  const mask = source.toBuffer('image/png'); const output = createCanvas(12, 10); output.getContext('2d').fillStyle = 'blue'; output.getContext('2d').fillRect(0, 0, 12, 10);
  let posted = ''; let contentType = ''; let route = ''; const server = http.createServer(async (request, response) => { route = request.url ?? ''; contentType = String(request.headers['content-type']); const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part)); posted = Buffer.concat(chunks).toString('latin1'); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ b64_json: output.toBuffer('image/png').toString('base64') }] })); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
  const images = await generateImageHttp({ prompt: 'make it blue', referenceImages: [sourcePath], maskImage: 'data:image/png;base64,' + mask.toString('base64'), outputDir: path.join(directory, 'outputs') }, { type: 'http', endpoint: `http://127.0.0.1:${port}/v1/images/generations`, provider: 'openai-images', model: 'gpt-image-1', apiKey: 'fixture-key' });
  expect(route).toBe('/v1/images/edits'); expect(contentType).toMatch(/^multipart\/form-data; boundary=/); expect(posted).toContain('name="image"'); expect(posted).toContain('name="mask"'); expect(posted).toContain('make it blue');
  expect(images).toHaveLength(1); expect(images[0]).toMatchObject({ width: 12, height: 10 }); const bytes = await fs.readFile(images[0].path); expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10])); expect((await loadImage(bytes)).width).toBe(12);
 });
});
