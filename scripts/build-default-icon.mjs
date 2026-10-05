#!/usr/bin/env node
/** Rasterize the source icon for Electron and the web UI at matching sizes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await fs.readFile(path.join(root, 'resources/icon.svg'));
const image = await loadImage(svg);
const canvas = createCanvas(1024, 1024);
canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024);
const png = canvas.toBuffer('image/png');

for (const output of ['resources/icon.png', 'public/icon.png']) {
  await fs.writeFile(path.join(root, output), png);
  process.stdout.write(`Wrote ${output}\n`);
}
