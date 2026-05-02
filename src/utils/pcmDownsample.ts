/** 麦克风 Float32 −1…1 → 16kHz s16le 样本（单向量）用于火山豆包 PCM 流 */
export function float32MonoToPCM16Mono16k(mono: Float32Array, inputRate: number): Int16Array {
  if (!mono.length || inputRate <= 0) return new Int16Array(0);
  if (Math.abs(inputRate - 16_000) < 1) {
    const o = new Int16Array(mono.length);
    for (let i = 0; i < mono.length; i++) {
      const s = Math.max(-1, Math.min(1, mono[i] ?? 0));
      o[i] = (s < 0 ? s * 0x8000 : s * 0x7fff) | 0;
    }
    return o;
  }
  const ratio = inputRate / 16_000;
  const outLen = Math.floor(mono.length / ratio);
  if (outLen <= 0) return new Int16Array(0);
  const o = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = Math.min(mono.length - 1, Math.floor(i * ratio));
    let s = Math.max(-1, Math.min(1, mono[srcIdx] ?? 0));
    o[i] = (s < 0 ? s * 0x8000 : s * 0x7fff) | 0;
  }
  return o;
}
