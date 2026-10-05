import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DocumentPage } from '../../src/features/documents/types';

const require = createRequire(import.meta.url);
const MAX_PAGES = 100;
const MAX_PIXELS = 12_000_000;
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('DOCUMENT_CANCELED'); }
function packageDir(name: string): string {
  const resolved = require.resolve(`${name}/package.json`);
  return path.dirname(resolved).replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}
export function resolveOcrLanguageDirectory(): string {
  return process.resourcesPath && /app\.asar/.test(import.meta.url)
    ? path.join(process.resourcesPath, 'ocr')
    : path.resolve('resources/ocr');
}
async function pdfEngine() {
  // Electron 28 embeds Node 18. PDF.js legacy supports it with these local shims.
  const p = Promise as unknown as { withResolvers?: () => unknown };
  if (!p.withResolvers) p.withResolvers = function () { let resolve!: (v: unknown) => void; let reject!: (r: unknown) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const canvas = await import('@napi-rs/canvas');
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['DOMMatrix', 'ImageData', 'Path2D'] as const) if (!g[key]) g[key] = canvas[key];
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdf.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(packageDir('pdfjs-dist'), 'legacy/build/pdf.worker.mjs')).href;
  return { pdf, canvas };
}
async function openPdf(filePath: string, signal?: AbortSignal) {
  abort(signal);
  const { pdf, canvas } = await pdfEngine();
  const buffer = await fs.readFile(filePath);
  abort(signal);
  class LocalCanvasFactory {
    create(width: number, height: number) { const surface = canvas.createCanvas(width, height); return { canvas: surface as unknown as HTMLCanvasElement, context: surface.getContext('2d') as unknown as CanvasRenderingContext2D }; }
    reset(target: { canvas: HTMLCanvasElement }, width: number, height: number) { target.canvas.width = width; target.canvas.height = height; }
    destroy(target: { canvas: HTMLCanvasElement | null; context: CanvasRenderingContext2D | null }) { if (target.canvas) { target.canvas.width = 1; target.canvas.height = 1; } target.canvas = null; target.context = null; }
  }
  const task = pdf.getDocument({ CanvasFactory: LocalCanvasFactory, data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, cMapUrl: path.join(packageDir('pdfjs-dist'), 'cmaps') + path.sep, cMapPacked: true, standardFontDataUrl: path.join(packageDir('pdfjs-dist'), 'standard_fonts') + path.sep });
  const onAbort = () => { void task.destroy(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try { return { document: await task.promise, canvas, cleanup: async () => { signal?.removeEventListener('abort', onAbort); await task.destroy(); } }; }
  catch (e) { signal?.removeEventListener('abort', onAbort); await task.destroy().catch(() => {}); abort(signal); throw e; }
}
async function rasterPage(page: Awaited<ReturnType<Awaited<ReturnType<typeof openPdf>>['document']['getPage']>>, canvas: Awaited<ReturnType<typeof pdfEngine>>['canvas'], signal?: AbortSignal) {
  abort(signal);
  let viewport = page.getViewport({ scale: 2 });
  if (viewport.width * viewport.height > MAX_PIXELS) viewport = page.getViewport({ scale: 2 * Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)) });
  const surface = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = surface.getContext('2d');
  const render = page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport, background: 'white' });
  const onAbort = () => render.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  try { await render.promise; abort(signal); return { buffer: surface.toBuffer('image/png'), width: surface.width, height: surface.height }; }
  finally { signal?.removeEventListener('abort', onAbort); }
}
export async function createOfflineOcr(signal?: AbortSignal) {
  const langPath = resolveOcrLanguageDirectory();
  for (const language of ['eng', 'chi_sim']) await fs.access(path.join(langPath, `${language}.traineddata.gz`)).catch(() => { throw new Error(`离线 OCR 语言资源缺失 / Missing offline OCR language: ${language}`); });
  abort(signal);
  const { createWorker } = await import('tesseract.js');
  let terminated = false;
  const initializing = createWorker('eng+chi_sim', 1, { langPath, gzip: true, cacheMethod: 'none', workerPath: path.join(packageDir('tesseract.js'), 'src/worker-script/node/index.js'), corePath: packageDir('tesseract.js-core') });
  let worker: Awaited<typeof initializing> | undefined;
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  void cancellation.catch(() => {});
  const onAbort = () => { terminated = true; void worker?.terminate(); rejectCancellation(new Error('DOCUMENT_CANCELED')); };
  void initializing.then((w) => { if (terminated) void w.terminate(); }).catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = await Promise.race([initializing, cancellation, new Promise<never>((_, reject) => { timer = setTimeout(() => { terminated = true; reject(new Error('OCR 初始化超时 / OCR initialization timed out')); }, 90_000); })]);
    abort(signal);
  } catch (e) { signal?.removeEventListener('abort', onAbort); void initializing.then((w) => w.terminate()).catch(() => {}); throw e; }
  finally { clearTimeout(timer); }
  return {
    async recognize(buffer: Buffer) {
      abort(signal);
      if (terminated || !worker) throw new Error('DOCUMENT_CANCELED');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const { data } = await Promise.race([worker.recognize(buffer), cancellation, new Promise<never>((_, reject) => { timeout = setTimeout(() => { terminated = true; void worker?.terminate(); reject(new Error('OCR 页面识别超时 / OCR page timed out')); }, 90_000); })]);
        abort(signal);
        return { text: data.text.trim(), confidence: data.confidence };
      } finally { clearTimeout(timeout); }
    },
    async close() { signal?.removeEventListener('abort', onAbort); if (!terminated) { terminated = true; await worker?.terminate(); } },
  };
}
export function ocrPageResult(page: number, result: { text: string; confidence: number }): DocumentPage {
  return result.text ? { page, ...result, method: 'ocr', ...(result.confidence < 60 ? { warning: '识别置信度较低，请核对原页 / Low OCR confidence; verify the source page' } : {}) } : { page, text: '', method: 'failed', confidence: result.confidence, error: '未识别到文字 / No text recognized' };
}
export async function extractPdfPages(filePath: string, options: { signal?: AbortSignal; ocr?: boolean } = {}): Promise<{ pages: DocumentPage[]; totalPages: number; truncated: boolean }> {
  const opened = await openPdf(filePath, options.signal);
  let ocr: Awaited<ReturnType<typeof createOfflineOcr>> | undefined;
  const pages: DocumentPage[] = [];
  try {
    for (let number = 1; number <= Math.min(MAX_PAGES, opened.document.numPages); number++) {
      abort(options.signal);
      try {
        const page = await opened.document.getPage(number);
        const items = (await page.getTextContent()).items;
        const text = items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
        if (text.length >= 8 || (text && options.ocr === false)) pages.push({ page: number, text, method: 'text' });
        else if (options.ocr !== false) {
          ocr ??= await createOfflineOcr(options.signal);
          const image = await rasterPage(page, opened.canvas, options.signal);
          const result = await ocr.recognize(image.buffer);
          pages.push(ocrPageResult(number, result));
        } else pages.push({ page: number, text: '', method: 'failed', error: '此页无文字层，需 OCR / No text layer; OCR required' });
        page.cleanup();
      } catch (e) { abort(options.signal); pages.push({ page: number, text: '', method: 'failed', error: e instanceof Error ? e.message : String(e) }); }
    }
    return { pages, totalPages: opened.document.numPages, truncated: opened.document.numPages > MAX_PAGES };
  } finally { await ocr?.close(); await opened.cleanup(); }
}
export async function renderPdfPage(filePath: string, pageNumber: number, signal?: AbortSignal) {
  const opened = await openPdf(filePath, signal);
  try {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > opened.document.numPages) throw new Error('页码超出范围 / Page out of range');
    const page = await opened.document.getPage(pageNumber);
    const result = await rasterPage(page, opened.canvas, signal);
    return { image: `data:image/png;base64,${result.buffer.toString('base64')}`, width: result.width, height: result.height };
  } finally { await opened.cleanup(); }
}
