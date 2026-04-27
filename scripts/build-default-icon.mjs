#!/usr/bin/env node
/**
 * 纯 Node（zlib）生成 1024×1024 PNG：青绿近满版圆角方（四角无生硬白环）+ 靛色圆底 + 加粗白轨道/核。
 * `npm run build:icon-default` 写入 resources/ 与 public/。
 */
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W = 1024;
const H = 1024;

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = -1 >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const CX = W / 2;
const CY = H / 2;

/** 缩小边距，主色更贴近 1024 画布边，Dock 上接近「满版」不露出浅灰/白外圈 */
const RR_PAD = 14;
const RR_R = 196;

/** sdRoundBox：p 相对中心，b 为直边半轴长，r 为圆角半径；<0 内、>0 外 */
function distToRoundRectEdge(x, y) {
  const b = (W - 2 * RR_PAD) / 2 - RR_R;
  const px = x - CX;
  const py = y - CY;
  const qx = Math.abs(px) - b;
  const qy = Math.abs(py) - b;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - RR_R;
}

const TEAL_A = [12, 108, 100];
const TEAL_B = [30, 142, 132];
const TEAL_C = [50, 172, 162];
const ORBIT = [255, 255, 255];
const ORBIT_MID = [215, 252, 248];
const CORE_HI = [255, 255, 255];
/** 原子图案背后的圆盘，与主色青绿区分的次色（蓝靛灰） */
const PLATE_C = [58, 68, 108];
const PLATE_E = [42, 52, 86];
const R_PLATE = 256;
const PLATE_AA = 2.2;
const PLATE_COVER = 0.82;

function rot(x, y, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad),
    s = Math.sin(rad);
  return [c * (x - CX) - s * (y - CY) + CX, s * (x - CX) + c * (y - CY) + CY];
}

/** 在旋转坐标系中点到椭圆 (cx,cy) rx,ry 边界的归一化距离，接近 0 为在环线上 */
function onEllipse(x, y, rx, ry, deg, thick) {
  const [xr, yr] = rot(x, y, -deg);
  const px = xr - CX;
  const py = yr - CY;
  if (rx < 1e-6 || ry < 1e-6) return 1e9;
  const t = Math.hypot(px / rx, py / ry);
  return Math.abs(t - 1) * Math.min(rx, ry);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** 与主体内青绿同系，四角色块不再出现浅白「外环」；与圆角内边缘视觉连续 */
function tealField(nx, ny) {
  const diagT = nx * 0.38 + ny * 0.62;
  const r = lerp(lerp(TEAL_A[0], TEAL_B[0], diagT), TEAL_C[0], 0.32 * (1 - Math.abs(nx - 0.5)));
  const g = lerp(lerp(TEAL_A[1], TEAL_B[1], diagT), TEAL_C[1], 0.32 * (1 - Math.abs(nx - 0.5)));
  const b = lerp(lerp(TEAL_A[2], TEAL_B[2], diagT), TEAL_C[2], 0.32 * (1 - Math.abs(nx - 0.5)));
  const c = 0.9 + 0.1 * (nx * ny);
  return [r * c, g * c, b * c];
}

function outerPixel(nx, ny) {
  return tealField(nx, ny);
}

function corePixel(x, y) {
  const dRect = distToRoundRectEdge(x, y);
  const nx = (x + 0.5) / W;
  const ny = (y + 0.5) / H;
  if (dRect > 0) {
    return outerPixel(nx, ny);
  }

  const dx = x - CX;
  const dy = y - CY;
  const dCenter = Math.hypot(dx, dy);

  const [r0, g0, b0] = tealField(nx, ny);
  let r = r0;
  let g = g0;
  let b = b0;

  const edgeBlend = smoothstep((-dRect) / 210);
  r = lerp(r * 0.88, r, 0.55 + 0.45 * edgeBlend);
  g = lerp(g * 0.88, g, 0.55 + 0.45 * edgeBlend);
  b = lerp(b * 0.88, b, 0.55 + 0.45 * edgeBlend);

  const spec = Math.max(0, 1 - Math.hypot(nx - 0.32, ny - 0.28) * 2.2);
  const spec2 = spec * spec;
  r = lerp(r, 255, 0.04 * spec2);
  g = lerp(g, 255, 0.05 * spec2);
  b = lerp(b, 255, 0.04 * spec2);

  const lift = 1 - Math.min(1, dCenter / 330);
  r += 18 * lift * lift;
  g += 22 * lift * lift;
  b += 20 * lift * lift;

  {
    const uEdge = 1 - smoothstep(R_PLATE, R_PLATE + PLATE_AA, dCenter);
    if (uEdge > 0) {
      const uR = dCenter / Math.max(1, R_PLATE);
      const pR = lerp(PLATE_C[0], PLATE_E[0], 0.55 * uR * uR);
      const pG = lerp(PLATE_C[1], PLATE_E[1], 0.55 * uR * uR);
      const pB = lerp(PLATE_C[2], PLATE_E[2], 0.55 * uR * uR);
      const m = uEdge * PLATE_COVER;
      r = lerp(r, pR, m);
      g = lerp(g, pG, m);
      b = lerp(b, pB, m);
    }
  }

  const rx = 212;
  const ry = 86;
  const lineW = 7.4;
  let best = 1e9;
  for (const ang of [0, 60, -60]) {
    const e = onEllipse(x, y, rx, ry, ang, lineW);
    if (e < best) best = e;
  }
  if (best < lineW) {
    const hi = 1 - best / lineW;
    r = lerp(r, lerp(ORBIT[0], ORBIT_MID[0], 0.1), 0.97 * hi);
    g = lerp(g, lerp(ORBIT[1], ORBIT_MID[1], 0.1), 0.97 * hi);
    b = lerp(b, lerp(ORBIT[2], ORBIT_MID[2], 0.1), 0.97 * hi);
  }

  if (dCenter < 24) {
    r = lerp(r, 252, 0.55 * (1 - dCenter / 24));
    g = lerp(g, 255, 0.55 * (1 - dCenter / 24));
    b = lerp(b, 255, 0.55 * (1 - dCenter / 24));
  }
  if (dCenter < 12) {
    r = CORE_HI[0];
    g = CORE_HI[1];
    b = CORE_HI[2];
  }

  const nodeAngles = [Math.PI / 2, (7 * Math.PI) / 6, (11 * Math.PI) / 6];
  const nodes = nodeAngles.map((t) => [CX + rx * Math.cos(t) * 0.94, CY + ry * Math.sin(t) * 0.94]);
  for (const [noX, noY] of nodes) {
    const nd = Math.hypot(x - noX, y - noY);
    if (nd < 11) {
      r = lerp(r, ORBIT_MID[0], 0.9);
      g = lerp(g, ORBIT_MID[1], 0.9);
      b = lerp(b, ORBIT_MID[2], 0.9);
    }
    if (nd < 5.5) {
      r = ORBIT[0];
      g = ORBIT[1];
      b = ORBIT[2];
    }
  }

  return [r, g, b];
}

function pixel(x, y) {
  const d = distToRoundRectEdge(x, y);
  const antialias = 1.4;
  const nx = (x + 0.5) / W;
  const ny = (y + 0.5) / H;
  const [outR, outG, outB] = outerPixel(nx, ny);

  if (d > antialias) {
    return [Math.round(outR), Math.round(outG), Math.round(outB), 255];
  }

  const [r0, g0, b0] = corePixel(x, y);
  if (d < -antialias) {
    return [Math.round(r0), Math.round(g0), Math.round(b0), 255];
  }
  const t = (antialias - d) / (2 * antialias);
  return [
    Math.round(lerp(outR, r0, t)),
    Math.round(lerp(outG, g0, t)),
    Math.round(lerp(outB, b0, t)),
    255,
  ];
}

const raw = Buffer.alloc((W * 4 + 1) * H);
let o = 0;
for (let y = 0; y < H; y++) {
  raw[o++] = 0;
  for (let x = 0; x < W; x++) {
    const [r, g, b, a] = pixel(x, y);
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
    raw[o++] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr.writeUInt8(8, 8);
ihdr.writeUInt8(6, 9);
ihdr.writeUInt8(0, 10);
ihdr.writeUInt8(0, 11);
ihdr.writeUInt8(0, 12);

const idat = zlib.deflateSync(raw, { level: 9 });
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const root = path.join(__dirname, '..');
const outRes = path.join(root, 'resources/icon.png');
const outPub = path.join(root, 'public/icon.png');
fs.mkdirSync(path.dirname(outRes), { recursive: true });
fs.mkdirSync(path.dirname(outPub), { recursive: true });
fs.writeFileSync(outRes, png);
fs.writeFileSync(outPub, png);
console.log('Wrote', outRes, 'and', outPub);
