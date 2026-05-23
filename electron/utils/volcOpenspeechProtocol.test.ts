// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  VOLC_OPENSPEECH_WS_URL,
  buildAudioFrame,
  buildFullClientFrame,
  parseServerBinaryMessage,
} from './volcOpenspeechProtocol';

describe('VOLC_OPENSPEECH_WS_URL', () => {
  it('指向豆包大模型双向流式 ASR', () => {
    expect(VOLC_OPENSPEECH_WS_URL).toMatch(/^wss:\/\/openspeech\.bytedance\.com\//);
    expect(VOLC_OPENSPEECH_WS_URL).toContain('/api/v3/sauc/bigmodel');
  });
});

describe('buildFullClientFrame（Full client request）', () => {
  it('包含 4B 头部、4B 长度，payload 为 gzip 后的 JSON', () => {
    const body = { user: { uid: 'u1' }, request: { reqid: 'r1' } };
    const frame = buildFullClientFrame(body);
    expect(frame.length).toBeGreaterThan(8);

    expect((frame[0] >> 4) & 0x0f).toBe(1);
    expect(frame[0] & 0x0f).toBe(1);

    expect((frame[1] >> 4) & 0x0f).toBe(0b0001);

    expect((frame[2] >> 4) & 0x0f).toBe(0b0001);
    expect(frame[2] & 0x0f).toBe(0b0001);

    const size = frame.readUInt32BE(4);
    expect(frame.length).toBe(8 + size);

    const json = JSON.parse(gunzipSync(frame.subarray(8)).toString('utf8'));
    expect(json).toEqual(body);
  });
});

describe('buildAudioFrame（audio only）', () => {
  it('positive seq：含 4B sequence 与 4B 长度，payload 为 gzip(pcm)', () => {
    const pcm = Buffer.from([0, 1, 2, 3, 4, 5]);
    const f = buildAudioFrame(pcm, 7, false);

    expect((f[1] >> 4) & 0x0f).toBe(0b0010);
    expect(f[1] & 0x0f).toBe(0b0001);

    const seq = f.readUInt32BE(4);
    expect(seq).toBe(7);

    const size = f.readUInt32BE(8);
    expect(f.length).toBe(12 + size);

    expect(gunzipSync(f.subarray(12)).equals(pcm)).toBe(true);
  });

  it('isLast：flags 低位为 0010 且不含 sequence', () => {
    const pcm = Buffer.from([9, 9]);
    const f = buildAudioFrame(pcm, 99, true);

    expect(f[1] & 0x0f).toBe(0b0010);

    const size = f.readUInt32BE(4);
    expect(f.length).toBe(8 + size);
    expect(gunzipSync(f.subarray(8)).equals(pcm)).toBe(true);
  });
});

describe('parseServerBinaryMessage', () => {
  function header(messageTypeNibble: number, flagsLow: number, useJson: boolean, useGzip: boolean) {
    const b = Buffer.alloc(4);
    b[0] = (1 << 4) | 1;
    b[1] = ((messageTypeNibble & 0x0f) << 4) | (flagsLow & 0x0f);
    b[2] = ((useJson ? 1 : 0) << 4) | (useGzip ? 1 : 0);
    b[3] = 0;
    return b;
  }

  it('过短帧返回 unknown', () => {
    expect(parseServerBinaryMessage(Buffer.alloc(4))).toEqual({ kind: 'unknown' });
  });

  it('error 帧：messageType 0b1111，含错误码与文本', () => {
    const msg = '配额不足';
    const msgBuf = Buffer.from(msg, 'utf8');
    const code = Buffer.alloc(4);
    code.writeUInt32BE(45000044, 0);
    const sz = Buffer.alloc(4);
    sz.writeUInt32BE(msgBuf.length, 0);
    const frame = Buffer.concat([header(0b1111, 0b0000, false, false), code, sz, msgBuf]);

    const r = parseServerBinaryMessage(frame);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.code).toBe(45000044);
      expect(r.message).toBe(msg);
    }
  });

  it('result 帧：JSON+Gzip+sequence，提取 result.text', () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text: '你好' } }), 'utf8'));
    const seq = Buffer.alloc(4);
    seq.writeUInt32BE(12, 0);
    const sz = Buffer.alloc(4);
    sz.writeUInt32BE(payload.length, 0);
    const frame = Buffer.concat([header(0b1001, 0b0001, true, true), seq, sz, payload]);

    const r = parseServerBinaryMessage(frame);
    expect(r.kind).toBe('result');
    if (r.kind === 'result') {
      expect(r.seq).toBe(12);
      expect(r.text).toBe('你好');
    }
  });

  it('result 帧无 sequence、payload 兜底 obj.text', () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ text: 'fallback' }), 'utf8'));
    const sz = Buffer.alloc(4);
    sz.writeUInt32BE(payload.length, 0);
    const frame = Buffer.concat([header(0b1001, 0b0000, true, true), sz, payload]);

    const r = parseServerBinaryMessage(frame);
    expect(r.kind).toBe('result');
    if (r.kind === 'result') {
      expect(r.seq).toBeNull();
      expect(r.text).toBe('fallback');
    }
  });

  it('未知消息类型返回 unknown', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(0, 0);
    const frame = Buffer.concat([header(0b0010, 0b0000, false, false), payload]);
    expect(parseServerBinaryMessage(frame)).toEqual({ kind: 'unknown' });
  });
});
