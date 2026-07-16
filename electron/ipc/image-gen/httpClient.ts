import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { URL as NodeURL } from 'node:url';

/**
 * Fetch/Undici 在「HTTP 200 + Content-Length: 0」与 chunked body 并存时可能读到空 body；
 * Node 原生 http 会完整拼接收到的分块，用于兜底。
 *
 * 使用绝对硬超时 + single-settle，响应体久不结束时会 destroy，避免主进程 IPC 永久挂起。
 */
function nodeRawPostJsonBody(
  endpoint: string,
  bodyJson: string,
  timeoutMs: number,
  extraHeaders?: Record<string, string>
): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }> {
  const u = new NodeURL(endpoint);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = u.port ? Number(u.port) : isHttps ? 443 : 80;

  return new Promise((resolve, reject) => {
    let settled = false;
    let resIncoming: http.IncomingMessage | null = null;
    let req!: http.ClientRequest;

    const settleOk = (payload: {
      statusCode: number;
      headers: IncomingHttpHeaders;
      body: Buffer;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      try {
        resIncoming?.removeAllListeners();
      } catch {
        /* ignore */
      }
      try {
        req.removeAllListeners();
      } catch {
        /* ignore */
      }
      resolve(payload);
    };

    const settleErr = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      try {
        resIncoming?.removeAllListeners();
        resIncoming?.destroy();
      } catch {
        /* ignore */
      }
      try {
        req.removeAllListeners();
        req.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    const hardKill = setTimeout(() => {
      settleErr(
        new Error(
          `生图兜底超时（>${Math.round(timeoutMs / 60_000)} 分钟）；可调 MYAGENT_IMAGE_GEN_FALLBACK_MS 或 MYAGENT_IMAGE_GEN_TIMEOUT_MS`
        )
      );
    }, timeoutMs);

    const chunks: Buffer[] = [];

    req = lib.request(
      {
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyJson, 'utf8'),
          Accept: 'application/json, application/x-ndjson, text/event-stream, image/png, image/*, */*',
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        resIncoming = res;
        res.on('data', (c: string | Buffer) => {
          chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
        });
        res.on('end', () =>
          settleOk({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', (e) => settleErr(e instanceof Error ? e : new Error(String(e))));
      }
    );

    req.on('error', (e) => settleErr(e));
    req.write(bodyJson, 'utf8');
    req.end();
  });
}

export { nodeRawPostJsonBody };
