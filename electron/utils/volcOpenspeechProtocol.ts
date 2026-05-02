import { gunzipSync, gzipSync } from 'node:zlib';

/** 豆包大模型双向流式：见 https://www.volcengine.com/docs/6561/1354869 */
const VOLC_WS_PATH = '/api/v3/sauc/bigmodel';
export const VOLC_OPENSPEECH_WS_URL = `wss://openspeech.bytedance.com${VOLC_WS_PATH}`;

/** version=1（高 4bit） headerSizeNibble=1 → 头部 4 字节（低 4bit） */
function packHeaderByte0(versionNibble = 1, headerSizeNibble = 1): number {
  return ((versionNibble & 0x0f) << 4) | (headerSizeNibble & 0x0f);
}

function encodeBaseHeader(opts: {
  messageTypeNibble: number;
  flagsNibble: number;
  serializationNibble: number;
  compressionNibble: number;
}): Buffer {
  const buf = Buffer.alloc(4);
  buf[0] = packHeaderByte0(1, 1);
  buf[1] = ((opts.messageTypeNibble & 0x0f) << 4) | (opts.flagsNibble & 0x0f);
  buf[2] = ((opts.serializationNibble & 0x0f) << 4) | (opts.compressionNibble & 0x0f);
  buf[3] = 0x00;
  return buf;
}

/** Full client request：JSON + Gzip（与文档示例一致） */
export function buildFullClientFrame(jsonBody: Record<string, unknown>): Buffer {
  const header = encodeBaseHeader({
    messageTypeNibble: 0b0001,
    flagsNibble: 0b0000,
    serializationNibble: 0b0001,
    compressionNibble: 0b0001,
  });
  const json = Buffer.from(JSON.stringify(jsonBody), 'utf8');
  const zipped = gzipSync(json);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(zipped.length, 0);
  return Buffer.concat([header, size, zipped]);
}

/** Audio only：payload 为 Gzip(rawPCM)；含正序号或最后一包 */
export function buildAudioFrame(pcmSlice: Buffer, seq: number, isLast: boolean): Buffer {
  const flags = isLast ? 0b0010 : 0b0001; // last vs positive seq
  const header = encodeBaseHeader({
    messageTypeNibble: 0b0010,
    flagsNibble: flags,
    serializationNibble: 0b0000,
    compressionNibble: 0b0001,
  });
  const zipped = gzipSync(pcmSlice);
  const chunks: Buffer[] = [header];
  if (!isLast) {
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeUInt32BE(seq >>> 0, 0);
    chunks.push(seqBuf);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(zipped.length, 0);
  chunks.push(size, zipped);
  return Buffer.concat(chunks);
}

export type ParsedVolcInbound =
  | { kind: 'result'; seq: number | null; text: string | null }
  | { kind: 'error'; code: number; message: string }
  | { kind: 'unknown' };

function tryGunzip(b: Buffer, useGzip: boolean): Buffer {
  if (!useGzip || b.length === 0) return b;
  try {
    return Buffer.from(gunzipSync(b));
  } catch {
    return b;
  }
}

/** 服务端 full server response / error frame */
export function parseServerBinaryMessage(data: Buffer): ParsedVolcInbound {
  if (data.length < 12) return { kind: 'unknown' };

  const messageType = (data[1] >> 4) & 0x0f;
  const serialization = (data[2] >> 4) & 0x0f;
  const compression = data[2] & 0x0f;

  const useJson = serialization === 0b0001;
  const useGzip = compression === 0b0001;

  if (messageType === 0b1111) {
    const code = data.readUInt32BE(4);
    const sz = data.readUInt32BE(8);
    const msgBuf = data.subarray(12, 12 + sz);
    return { kind: 'error', code, message: msgBuf.toString('utf8') };
  }

  if (messageType !== 0b1001 || !useJson) return { kind: 'unknown' };

  let offset = 4;
  const flagsLow = data[1] & 0x0f;

  /** 服务端 full response：flags 低位为 0001 时带 4B sequence（文档示例如此） */
  let seqNum: number | null = null;
  if ((flagsLow & 0x01) === 0x01) {
    if (data.length < offset + 4) return { kind: 'unknown' };
    seqNum = data.readUInt32BE(offset);
    offset += 4;
  }

  const payloadSize = data.readUInt32BE(offset);
  offset += 4;
  if (data.length < offset + payloadSize) return { kind: 'unknown' };
  let rawPayload = data.subarray(offset, offset + payloadSize);
  rawPayload = tryGunzip(rawPayload, useGzip);

  let text: string | null = null;
  try {
    const obj = JSON.parse(rawPayload.toString('utf8')) as {
      result?: { text?: string };
      text?: string;
    };
    if (typeof obj?.result?.text === 'string') text = obj.result.text;
    else if (typeof obj?.text === 'string') text = obj.text;
  } catch {
    return { kind: 'unknown' };
  }

  return { kind: 'result', seq: seqNum, text };
}
