import { describe, it, expect, vi } from 'vitest';

vi.mock('@/utils/loadImage', () => ({
  loadImage: vi.fn(),
}));

import { toModelBuffer } from './mediapipeLoader';

describe('toModelBuffer', () => {
  it('Uint8Array 直通', () => {
    const u8 = new Uint8Array([1, 2, 3, 4]);
    expect(toModelBuffer(u8)).toBe(u8);
  });
  it('{ buffer: ArrayBuffer } 包装为 Uint8Array', () => {
    const ab = new ArrayBuffer(4);
    const u8 = toModelBuffer({ buffer: ab });
    expect(u8).toBeInstanceOf(Uint8Array);
    expect(u8.byteLength).toBe(4);
  });
  it('裸 ArrayBuffer 包装', () => {
    const ab = new ArrayBuffer(8);
    const u8 = toModelBuffer(ab);
    expect(u8).toBeInstanceOf(Uint8Array);
    expect(u8.byteLength).toBe(8);
  });
  it('null / undefined 返空 Uint8Array（不应抛错）', () => {
    expect(toModelBuffer(null).byteLength).toBe(0);
    expect(toModelBuffer(undefined).byteLength).toBe(0);
  });
});
