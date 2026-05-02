import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BrowserWindow, ipcMain } from 'electron';
import WebSocket from 'ws';
import {
  VOLC_OPENSPEECH_WS_URL,
  buildFullClientFrame,
  buildAudioFrame,
  parseServerBinaryMessage,
} from '../utils/volcOpenspeechProtocol';

export type VolcWarmStartPayload = {
  appKey: string;
  accessKey: string;
  resourceId: string;
};

let activeVolcSender: Electron.WebContents | null = null;

class VolcStreamAsrSession {
  private ws: WebSocket | null = null;
  /** V1：首个 full client 等价占序号 1；首帧 audio-only 必须从 2 开始，否则会 sequence mismatch */
  private seq = 2;

  constructor(
    private readonly creds: VolcWarmStartPayload,
    private readonly sender: Electron.WebContents | null
  ) {}

  async connectAndHandshake(): Promise<void> {
    const connectId = randomUUID();
    this.ws = new WebSocket(VOLC_OPENSPEECH_WS_URL, {
      headers: {
        'X-Api-App-Key': this.creds.appKey.trim(),
        'X-Api-Access-Key': this.creds.accessKey.trim(),
        'X-Api-Resource-Id': this.creds.resourceId.trim(),
        'X-Api-Connect-Id': connectId,
      },
    });

    await new Promise<void>((resolve, reject) => {
      const w = this.ws!;
      let settled = false;
      const tid = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('websocket open timeout'));
      }, 15_000);

      /** HTTP 握手未返回 101 时先于 error 触发，便于读出 400 响应体排查鉴权问题 */
      w.once('unexpected-response', (_req: unknown, res: IncomingMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(tid);
        const code = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer | string) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
        );
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8').trim().slice(0, 800);
          const tail = txt || `${res.statusMessage ?? ''}`.trim() || '（响应体为空）';
          reject(new Error(`语音识别 WebSocket 握手失败 HTTP ${code}：${tail}`));
        });
        res.resume();
      });

      w.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(tid);
        resolve();
      });

      w.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(tid);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    const fullClientPayload = {
      user: {
        uid: 'myagent-desktop',
        did: 'electron',
        platform: `electron_${process.platform}`,
      },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: 16_000,
        bits: 16,
        channel: 1,
      },
      request: {
        model_name: 'bigmodel',
        result_type: 'full',
        enable_itn: true,
        enable_punc: true,
      },
    };

    const w = this.ws!;
    w.send(buildFullClientFrame(fullClientPayload));

    w.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const chunks = Array.isArray(data)
        ? Buffer.concat(data as Buffer[])
        : Buffer.isBuffer(data as Buffer)
          ? (data as Buffer)
          : Buffer.from(data as ArrayBuffer);
      try {
        const parsed = parseServerBinaryMessage(chunks);
        if (parsed.kind === 'result' && parsed.text !== null && parsed.text !== '') {
          this.emitText(parsed.text);
        } else if (parsed.kind === 'error') {
          this.emitError(`${parsed.code} ${parsed.message}`);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.emitError(msg);
      }
    });

    w.once('close', () => {
      this.emitEnded();
      this.ws = null;
      if (activeVolcSender === this.sender) activeVolcSender = null;
    });

    w.on('error', (err) => {
      this.emitError(err.message || 'websocket-error');
    });
  }

  pushPcm(buffer: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(buildAudioFrame(buffer, this.seq++, false));
    } catch {
      /* ignore */
    }
  }

  finish(): void {
    const sock = this.ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    try {
      sock.send(buildAudioFrame(Buffer.alloc(0), this.seq++, true));
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
      } catch {
        /* ignore */
      }
    }, 520);
  }

  abort(): void {
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (activeVolcSender === this.sender) activeVolcSender = null;
  }

  private emitText(text: string): void {
    try {
      this.sender?.send('volc-asr-text', text);
    } catch {
      /* renderer gone */
    }
  }

  private emitError(message: string): void {
    try {
      this.sender?.send('volc-asr-error', message);
    } catch {
      /* ignore */
    }
  }

  private emitEnded(): void {
    try {
      this.sender?.send('volc-asr-ended', null);
    } catch {
      /* ignore */
    }
  }
}

let activeSession: VolcStreamAsrSession | null = null;

ipcMain.handle('volc-asr-start', async (event, payload: VolcWarmStartPayload) => {
  activeSession?.abort();
  const wc = BrowserWindow.fromWebContents(event.sender)?.webContents ?? event.sender;
  activeVolcSender = wc;
  const session = new VolcStreamAsrSession(
    {
      appKey: String(payload?.appKey ?? ''),
      accessKey: String(payload?.accessKey ?? ''),
      resourceId: String(payload?.resourceId ?? ''),
    },
    wc
  );
  activeSession = session;
  try {
    await session.connectAndHandshake();
    return { ok: true as const };
  } catch (e: unknown) {
    activeSession = null;
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false as const, error: msg.slice(0, 400) };
  }
});

ipcMain.handle('volc-asr-chunk', (_e, int16Nums: unknown) => {
  if (!activeSession || !Array.isArray(int16Nums)) return { ok: false as const };
  const ints = int16Nums as number[];
  if (ints.length < 64) return { ok: false as const };
  const buf = Buffer.allocUnsafe(ints.length * 2);
  for (let i = 0; i < ints.length; i++) buf.writeInt16LE(ints[i] | 0, i * 2);
  activeSession.pushPcm(buf);
  return { ok: true as const };
});

ipcMain.handle('volc-asr-finish', () => {
  activeSession?.finish();
  return { ok: true as const };
});

ipcMain.handle('volc-asr-abort', () => {
  activeSession?.abort();
  activeSession = null;
  return { ok: true as const };
});
