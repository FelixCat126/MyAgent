// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { createOfflineOcr, extractPdfPages, ocrPageResult, renderPdfPage } from './pdf';
import { extractTextFromPath } from '../utils/documentText';
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-pdf-')); });
afterEach(async () => { await fs.rm(dir, { force: true, recursive: true }); });
function pdfFile(pages: ({ text: string } | { image: Buffer; width: number; height: number })[]): Buffer {
  const objects: Buffer[] = []; const refs: number[] = [];
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>')); objects.push(Buffer.alloc(0));
  for (const page of pages) {
    const n = objects.length + 1; refs.push(n);
    const stream = 'text' in page ? `BT /F1 24 Tf 72 720 Td (${page.text}) Tj ET` : 'q 612 0 0 204 0 420 cm /Im1 Do Q';
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${n + 2} 0 R >> ${'image' in page ? `/XObject << /Im1 ${n + 3} 0 R >>` : ''} >> /Contents ${n + 1} 0 R >>`));
    objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)); objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
    if ('image' in page) objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.length} >>\nstream\n`), page.image, Buffer.from('\nendstream')]));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${refs.map((r) => `${r} 0 R`).join(' ')}] /Count ${refs.length} >>`);
  const parts = [Buffer.from('%PDF-1.4\n')]; const offsets = [0]; let size = parts[0].length;
  objects.forEach((object, i) => { offsets.push(size); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); parts.push(part); size += part.length; });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`));
  return Buffer.concat(parts);
}
describe('local PDF and offline OCR integration', () => {
  it('flags low-confidence text without dropping it and cancels real worker initialization', async () => {
    const page = ocrPageResult(3, { text: 'Uncertain 123', confidence: 28 }); expect(page.text).toBe('Uncertain 123'); expect(page.warning).toContain('Low OCR confidence');
    const controller = new AbortController(); const pending = createOfflineOcr(controller.signal); setTimeout(() => controller.abort(), 5); await expect(pending).rejects.toThrow('DOCUMENT_CANCELED');
  }, 10_000);
  it('extracts real text PDFs with page citations and renders a page image', async () => {
    const file = path.join(dir, 'text.pdf'); await fs.writeFile(file, pdfFile([{ text: 'Quarterly Revenue 12345' }, { text: 'Second Page 67890' }]));
    const result = await extractPdfPages(file, { ocr: false }); expect(result.pages.map((p) => p.method)).toEqual(['text', 'text']); expect(result.pages[0].text).toContain('12345'); expect(result.pages[1].page).toBe(2);
    const image = await renderPdfPage(file, 2); expect(image.image.startsWith('data:image/png;base64,')).toBe(true); expect(image.width).toBeGreaterThan(600);
    const extracted = await extractTextFromPath(file); expect(extracted.text).toContain('Page 2'); expect(extracted.kind).toBe('pdf');
  }, 30_000);
  it('runs real offline OCR on an image-only scanned PDF and a PNG', async () => {
    const canvas = createCanvas(1200, 400); const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 1200, 400); context.fillStyle = 'black'; context.font = 'bold 70px Arial'; context.fillText('INVOICE 12345', 70, 160); context.font = '60px Arial'; context.fillText('TOTAL 67890', 70, 290);
    const file = path.join(dir, 'scan.pdf'); await fs.writeFile(file, pdfFile([{ image: canvas.toBuffer('image/jpeg'), width: 1200, height: 400 }]));
    const result = await extractPdfPages(file); expect(result.pages[0].method, result.pages[0].error).toBe('ocr'); expect(result.pages[0].text).toContain('12345'); expect(result.pages[0].confidence).toBeGreaterThan(50);
    const image = path.join(dir, 'scan.png'); await fs.writeFile(image, canvas.toBuffer('image/png')); const extracted = await extractTextFromPath(image); expect(extracted.kind).toBe('image-ocr'); expect(extracted.text).toContain('67890');
  }, 120_000);
  it('reports a blank page without pretending extraction succeeded and rejects cancellation', async () => {
    const file = path.join(dir, 'blank.pdf'); await fs.writeFile(file, pdfFile([{ text: '' }, { text: 'Visible Page' }])); const result = await extractPdfPages(file, { ocr: false }); expect(result.pages[0].method).toBe('failed'); expect(result.pages[1].method).toBe('text'); expect(result.pages[0].error).toContain('OCR required');
    const controller = new AbortController(); controller.abort(); await expect(extractPdfPages(file, { signal: controller.signal })).rejects.toThrow('DOCUMENT_CANCELED'); await expect(renderPdfPage(file, 9)).rejects.toThrow(/Page out of range/);
  }, 30_000);
});
