// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { generateMiniMaxVideo } from './minimaxVideoAdapter';
let directory: string; let server: http.Server; let endpoint: string; let submissions: number; let queries: number; let mode: 'success' | 'fail' | 'waiting' | 'bad-download'; let saved = false;
const video = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50]);
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-video-')); submissions = 0; queries = 0; mode = 'success'; saved = false;
  server = http.createServer((request, response) => {
    const url = new URL(request.url!, endpoint); response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/v1/video_generation' && request.method === 'POST') { submissions++; response.end(JSON.stringify({ task_id: 'test-job', base_resp: { status_code: 0 } })); }
    else if (url.pathname === '/v1/query/video_generation') { queries++; if (!saved) { response.statusCode = 400; response.end('checkpoint not saved'); return; } if (url.searchParams.get('task_id') !== 'test-job') { response.statusCode = 400; response.end('bad id'); return; } response.end(JSON.stringify({ status: mode === 'fail' ? 'Fail' : mode === 'waiting' || queries === 1 ? 'Processing' : 'Success', file_id: 'file-1', base_resp: { status_code: 0 } })); }
    else if (url.pathname === '/v1/files/retrieve') response.end(JSON.stringify({ file: { download_url: endpoint + '/file.mp4' }, base_resp: { status_code: 0 } }));
    else if (url.pathname === '/v1/video_generation/file.mp4') { response.setHeader('Content-Type', 'video/mp4'); response.end(mode === 'bad-download' ? Buffer.from('{"not":"video"}') : video); }
    else { response.statusCode = 404; response.end(JSON.stringify({ error: url.pathname })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number }; endpoint = `http://127.0.0.1:${address.port}/v1/video_generation`;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); });
const configuration = () => ({ apiKey: 'fixture-only', endpoint, model: 'MiniMax-Hailuo-02', prompt: 'fixture video', pollIntervalMs: 2, timeoutMs: 2000, outputDir: directory, onSubmitted: async (id: string) => { expect(id).toBe('test-job'); saved = true; } });
describe('video submission, recovery and actual cancellation', () => {
  it('persists the job before querying correct endpoint and downloads validated bytes', async () => {
    const result = await generateMiniMaxVideo(configuration()); expect(result.taskId).toBe('test-job'); expect(submissions).toBe(1); expect(queries).toBe(2); expect(await fs.readFile(result.localPath)).toEqual(video);
  });
  it('resumes an existing job without creating or charging for another submission', async () => {
    saved = true; const result = await generateMiniMaxVideo({ ...configuration(), existingTaskId: 'test-job' }); expect(submissions).toBe(0); expect(result.taskId).toBe('test-job');
  });
  it('recognizes Fail and rejects downloaded JSON pretending to be video', async () => {
    mode = 'fail'; await expect(generateMiniMaxVideo(configuration())).rejects.toThrow(/task failed/); expect(queries).toBe(1);
    mode = 'bad-download'; saved = true; await expect(generateMiniMaxVideo({ ...configuration(), existingTaskId: 'test-job' })).rejects.toThrow(/MP4 container/); expect(await fs.readdir(directory)).toEqual([]);
  });
  it('aborts polling immediately and leaves no incomplete output', async () => {
    mode = 'waiting'; const controller = new AbortController(); const pending = generateMiniMaxVideo({ ...configuration(), signal: controller.signal, pollIntervalMs: 1000 }); setTimeout(() => controller.abort(new Error('Stopped fixture')), 20); await expect(pending).rejects.toThrow(/Stopped fixture|canceled/); expect(submissions).toBe(1); expect(await fs.readdir(directory)).toEqual([]);
  });
});
