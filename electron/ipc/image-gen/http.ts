import { join } from 'path';
import fs from 'fs/promises';
import type { ModelConfig, ImageGenerationParams } from '../../../src/types';
import { stripUtf8Bom, looksLikeBinaryImage, base64FieldToImageBuffer } from './parsing';
import {
  mergedCustomHeadersForImageHttp,
  getAuthorizationHeaderValue,
  secretKeyHint,
  sanitizeSecretToken,
  hasExplicitAuthorizationHeader,
  firstMatchingEnvKey,
  effectiveImageProvider,
  extraHttpHeadersFromImageEnv,
  VOLC_API_KEY_CANDIDATES,
  BAILIAN_API_KEY_CANDIDATES,
  OPENAI_API_KEY_CANDIDATES,
  ZHIPU_API_KEY_CANDIDATES,
  MINIMAX_API_KEY_CANDIDATES,
} from './auth';
import { formatAxiosGenerateHttpError, bailianHttpErrorHint } from './formatError';
import {
  IMAGE_GEN_TIMEOUT_MS,
  IMAGE_GEN_FALLBACK_MS,
  OLLAMA_EMPTY_PROBE_MS,
} from './queue';
import { nodeRawPostJsonBody } from './httpClient';
import {
  extractImageBufferFromJson,
  extractOpenAiCompatibleImageDownloadUrl,
  collectImageUrlsFromArkStreamOrPlainJson,
  readResponseBodyAsUtf8Streaming,
} from './responseParsers';
import {
  writePngBuffersToOutputFiles,
  finalizeOnePngBuffer,
  fetchImageBinaryFromUrl,
} from './buffers';
import {
  buildSiblingEndpoint,
  fetchOllamaVersion,
  tryOllamaOpenAiImagesFallback,
  summarizeOllamaProgressOnlyBody,
  extractImageFromOllamaFriendlyBody,
} from './ollamaHelpers';
import {
  httpImageProviderAdapters,
  extractImagesFromBailianResponse,
  extractImagesFromMiniMaxResponse,
  looksLikeMiniMaxResponseJson,
  peekMiniMaxStatusCode,
  alternateMiniMaxImageEndpoint,
  type HttpImageMode,
  type UnifiedImageRequest,
  type BuiltImageHttpRequest,
} from './adapters';

function buildUnifiedImageRequest(params: ImageGenerationParams): UnifiedImageRequest {
  const count =
    typeof params.count === 'number' && Number.isFinite(params.count) && params.count > 0
      ? Math.max(1, Math.round(params.count))
      : 1;
  return {
    prompt: params.prompt ?? '',
    width: params.width,
    height: params.height,
    count,
    referenceImages: Array.isArray(params.referenceImages) ? params.referenceImages : [],
    params,
  };
}

async function buildImageHttpRequestViaAdapter(ctx: {
  mode: HttpImageMode;
  endpoint: string;
  config: NonNullable<ModelConfig['imageGeneratorConfig']>;
  headers: Record<string, string>;
  params: ImageGenerationParams;
}): Promise<BuiltImageHttpRequest> {
  const request = buildUnifiedImageRequest(ctx.params);
  const adapter = httpImageProviderAdapters.find((a) =>
    a.match({ mode: ctx.mode, endpoint: ctx.endpoint, config: ctx.config })
  )!;
  const built = await adapter.build({
    endpoint: ctx.endpoint,
    config: ctx.config,
    env: ctx.config.env,
    request,
    headers: ctx.headers,
  });
  return {
    ...built,
    mode: built.mode === 'auto' ? ctx.mode : built.mode,
  };
}

function detectHttpFormat(
  endpoint: string,
  explicit?: ModelConfig['imageGeneratorConfig']
): 'sdwebui' | 'ollama' | 'raw' | 'openai_images' | 'auto' {
  const ex = explicit?.httpFormat;
  if (ex && ex !== 'auto') return ex;
  const u = endpoint.toLowerCase();
  if (/\/images\/generations/i.test(endpoint)) return 'openai_images';
  if (u.includes('sdapi/v1/txt2img') || u.includes('txt2img')) return 'sdwebui';
  /** Ollama 生图 POST /api/generate；须在 openai_images 之后才判断路径 */
  if (u.includes('/api/generate')) return 'ollama';
  return 'auto';
}

function describeImageHttpAuth(config: NonNullable<ModelConfig['imageGeneratorConfig']>, env: Record<string, string> | undefined, headers: Record<string, string>): { source: string; keyHint: string } {
  const auth = getAuthorizationHeaderValue(headers);
  const hint = secretKeyHint(auth);
  const structured = typeof config.apiKey === 'string' ? sanitizeSecretToken(config.apiKey) : '';
  if (structured) return { source: '生图「API 密钥」字段', keyHint: secretKeyHint(structured) || hint };
  let envKey: string | undefined;
  switch (effectiveImageProvider(config)) {
    case 'bailian-wanx': envKey = firstMatchingEnvKey(env, BAILIAN_API_KEY_CANDIDATES); break;
    case 'volc-seedream': envKey = firstMatchingEnvKey(env, VOLC_API_KEY_CANDIDATES); break;
    case 'openai-images': envKey = firstMatchingEnvKey(env, OPENAI_API_KEY_CANDIDATES) ?? firstMatchingEnvKey(env, VOLC_API_KEY_CANDIDATES); break;
    case 'zhipu-cogview': envKey = firstMatchingEnvKey(env, ZHIPU_API_KEY_CANDIDATES); break;
    case 'minimax': envKey = firstMatchingEnvKey(env, MINIMAX_API_KEY_CANDIDATES); break;
    default: envKey = firstMatchingEnvKey(env, OPENAI_API_KEY_CANDIDATES) ?? firstMatchingEnvKey(env, BAILIAN_API_KEY_CANDIDATES) ?? firstMatchingEnvKey(env, MINIMAX_API_KEY_CANDIDATES) ?? firstMatchingEnvKey(env, ZHIPU_API_KEY_CANDIDATES) ?? firstMatchingEnvKey(env, VOLC_API_KEY_CANDIDATES);
  }
  if (envKey) return { source: `环境变量 ${envKey}`, keyHint: hint };
  if (hasExplicitAuthorizationHeader(extraHttpHeadersFromImageEnv(env))) return { source: '环境变量 HEADER_AUTHORIZATION', keyHint: hint };
  if (auth) return { source: 'Authorization 请求头', keyHint: hint };
  return { source: '未携带', keyHint: '' };
}

async function generateImageHttp(
  params: ImageGenerationParams,
  config: NonNullable<ModelConfig['imageGeneratorConfig']>
): Promise<Array<{ url: string; path: string; width: number; height: number }>> {
  if (!config.endpoint?.trim()) {
    throw new Error('请配置生图 HTTP 接口 URL');
  }

  const appModule = await import('electron');
  const electronApp = appModule.app;

  const outputDir =
    params.outputDir ||
    join(electronApp.getPath('documents'), 'MyAgent', 'GeneratedImages');
  await fs.mkdir(outputDir, { recursive: true }).catch(() => {});

  const configuredEndpoint = config.endpoint.trim();
  const mode = detectHttpFormat(configuredEndpoint, config);
  const customHdr = mergedCustomHeadersForImageHttp(config.env, config);
  const authMeta = describeImageHttpAuth(config, config.env, customHdr);

  /** Node 兜底请求也需鉴权头等（远端 OpenAI Images 同理） */
  const mergedFetchHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
    Accept: 'application/json, application/x-ndjson, text/event-stream, image/png, image/*, */*',
    ...customHdr,
  };

  const builtReq = await buildImageHttpRequestViaAdapter({
    mode,
    endpoint: configuredEndpoint,
    config,
    headers: mergedFetchHeaders,
    params,
  });
  const postBody = builtReq.body;
  const providerKind = builtReq.provider;
  let requestUrl = (builtReq.endpoint || configuredEndpoint).trim();
  const ollamaModel = builtReq.ollamaModel || config.env?.OLLAMA_MODEL || config.env?.ollama_model || 'flux';
  const volcOpenAi = Boolean(builtReq.volcOpenAi);
  const readBodyAsStreamingText = Boolean(builtReq.readBodyAsStreamingText);

  if (providerKind === 'minimax') {
    console.warn('[生图 HTTP] MiniMax 请求', {
      url: requestUrl.slice(0, 220),
      authSource: authMeta.source,
      keyHint: authMeta.keyHint || undefined,
    });
  }

  /**
   * 「fetch + 读完 body」共用同一 AbortSignal 与时间预算：不可在仅收到头部后清掉定时器，
   * 否则 Undici 在 body 挂起时会无限 await，主进程 IPC 卡死、整个应用无响应。
   */
  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => abortCtrl.abort(), IMAGE_GEN_TIMEOUT_MS);

  let response: Response;
  let buf: Buffer;

  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: mergedFetchHeaders,
      body: JSON.stringify(postBody),
      signal: abortCtrl.signal,
    });
    if (readBodyAsStreamingText) {
      buf = Buffer.from(await readResponseBodyAsUtf8Streaming(response), 'utf8');
    } else {
      buf = Buffer.from(await response.arrayBuffer());
    }
  } catch (e: unknown) {
    const nm = e instanceof Error ? e.name : '';
    const msg = e instanceof Error ? e.message : String(e);
    if (nm === 'AbortError') {
      throw new Error(
        `生图请求超时（>${Math.round(IMAGE_GEN_TIMEOUT_MS / 60_000)} 分钟）；可用环境变量 MYAGENT_IMAGE_GEN_TIMEOUT_MS（毫秒）调大限时`
      );
    }
    throw new Error(`生图 HTTP 请求失败（含读取响应体）：${msg}`);
  } finally {
    clearTimeout(abortTimer);
  }

  /** MiniMax 2049 常见于国内/国际站与 Key 不匹配：自动换站重试一次 */
  if (providerKind === 'minimax' && buf.length && response.ok) {
    try {
      const peeked = JSON.parse(stripUtf8Bom(buf.toString('utf8'))) as unknown;
      if (peekMiniMaxStatusCode(peeked) === 2049) {
        const alt = alternateMiniMaxImageEndpoint(requestUrl);
        if (alt && alt !== requestUrl) {
          console.warn('[生图 HTTP] MiniMax status_code=2049，尝试另一站点', {
            from: requestUrl.slice(0, 220),
            to: alt.slice(0, 220),
            authSource: authMeta.source,
          });
          const retryCtrl = new AbortController();
          const retryTimer = setTimeout(() => retryCtrl.abort(), IMAGE_GEN_TIMEOUT_MS);
          try {
            const retryRes = await fetch(alt, {
              method: 'POST',
              headers: mergedFetchHeaders,
              body: JSON.stringify(postBody),
              signal: retryCtrl.signal,
            });
            const retryBuf = Buffer.from(await retryRes.arrayBuffer());
            if (retryRes.ok && retryBuf.length) {
              let retryOk = false;
              try {
                const retryJson = JSON.parse(stripUtf8Bom(retryBuf.toString('utf8'))) as unknown;
                const retryCode = peekMiniMaxStatusCode(retryJson);
                retryOk = retryCode === null || retryCode === 0;
              } catch {
                retryOk = false;
              }
              if (retryOk) {
                response = retryRes;
                buf = retryBuf;
                requestUrl = alt;
              }
            }
          } finally {
            clearTimeout(retryTimer);
          }
        }
      }
    } catch {
      /* 非 JSON 或解析失败则走原解析路径 */
    }
  }

  let httpStatus = response.status;
  let ct = String(response.headers.get('content-type') ?? '').toLowerCase();
  let clHdr = response.headers.get('content-length');
  const teHdr = response.headers.get('transfer-encoding');
  let lastEmptyDiagEndpoint = requestUrl;
  /** 后续兜底/解析统一用实际请求 URL（可能已换站） */
  const endpoint = requestUrl;

  if (!response.ok) {
    /** 按厂商给出针对性排查提示，避免一律显示 Ollama 模板 */
    let hint: string | undefined;
    if (providerKind === 'bailian-wanx') hint = bailianHttpErrorHint(endpoint);
    throw new Error(formatAxiosGenerateHttpError(endpoint, httpStatus, buf, hint));
  }

  const bodyPayload = JSON.stringify(postBody);

  if (!buf.length && response.ok) {
    console.warn('[生图 HTTP] fetch 读到 0 字节，尝试 Node http/https 兜底', {
      te: teHdr,
      cl: clHdr,
      endpoint: endpoint.slice(0, 220),
    });
    try {
      const raw = await nodeRawPostJsonBody(endpoint, bodyPayload, IMAGE_GEN_FALLBACK_MS, customHdr);
      if (raw.body.length > 0) {
        buf = raw.body;
        httpStatus = raw.statusCode;
        const hCl = raw.headers['content-length'];
        clHdr = Array.isArray(hCl) ? hCl[0] ?? null : hCl ?? null;
        ct = String(raw.headers['content-type'] ?? '').toLowerCase();
      } else if (raw.statusCode < 200 || raw.statusCode >= 300) {
        throw new Error(formatAxiosGenerateHttpError(endpoint, raw.statusCode, raw.body));
      }
    } catch (e: unknown) {
      console.warn('[生图 HTTP] Node 兜底未完成或失败:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * 部分 Ollama 生图在 stream:false 时对 /api/generate 返回 HTTP 200 + Content-Length:0，
   * 流式下才输出 NDJSON 片段（最后一行常带 image）。
   */
  if (!buf.length && mode === 'ollama' && httpStatus >= 200 && httpStatus < 300) {
    console.warn('[生图 HTTP] 仍为 0 字节；改用 stream:true 再请求一次', {
      model: ollamaModel,
      endpoint: endpoint.slice(0, 220),
    });
    try {
      const streamPayload = JSON.stringify({
        ...postBody,
        stream: true,
      });
      const raw = await nodeRawPostJsonBody(endpoint, streamPayload, OLLAMA_EMPTY_PROBE_MS, customHdr);
      if (raw.body.length > 0 && raw.statusCode >= 200 && raw.statusCode < 300) {
        buf = raw.body;
        httpStatus = raw.statusCode;
        const hCl = raw.headers['content-length'];
        clHdr = Array.isArray(hCl) ? hCl[0] ?? null : hCl ?? null;
        ct = String(raw.headers['content-type'] ?? '').toLowerCase();
      } else if (raw.statusCode < 200 || raw.statusCode >= 300) {
        throw new Error(formatAxiosGenerateHttpError(endpoint, raw.statusCode, raw.body));
      }
    } catch (e: unknown) {
      console.warn('[生图 HTTP] stream:true 兜底失败:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * Ollama 的实验生图模型在部分版本上对 /api/generate 直接返回空 body；
   * 新版/兼容层可能只在 OpenAI Images 路径返回 b64_json，因此再试一次同 host 的兼容端点。
   */
  if (!buf.length && mode === 'ollama' && httpStatus >= 200 && httpStatus < 300) {
    const imagesEndpoint = buildSiblingEndpoint(endpoint, '/v1/images/generations');
    if (imagesEndpoint) {
      console.warn('[生图 HTTP] 仍为 0 字节；改用 /v1/images/generations 再请求一次', {
        model: ollamaModel,
        endpoint: imagesEndpoint.slice(0, 220),
      });
      const size =
        typeof params.width === 'number' &&
        params.width > 0 &&
        typeof params.height === 'number' &&
        params.height > 0
          ? `${params.width}x${params.height}`
          : undefined;
      const imagesPayload = JSON.stringify({
        model: ollamaModel,
        prompt: params.prompt ?? '',
        ...(size ? { size } : {}),
        response_format: 'b64_json',
      });
      try {
        const raw = await nodeRawPostJsonBody(
          imagesEndpoint,
          imagesPayload,
          OLLAMA_EMPTY_PROBE_MS,
          customHdr
        );
        lastEmptyDiagEndpoint = imagesEndpoint;
        if (raw.body.length > 0 && raw.statusCode >= 200 && raw.statusCode < 300) {
          buf = raw.body;
          httpStatus = raw.statusCode;
          const hCl = raw.headers['content-length'];
          clHdr = Array.isArray(hCl) ? hCl[0] ?? null : hCl ?? null;
          ct = String(raw.headers['content-type'] ?? '').toLowerCase();
        } else if (raw.statusCode < 200 || raw.statusCode >= 300) {
          throw new Error(formatAxiosGenerateHttpError(imagesEndpoint, raw.statusCode, raw.body));
        }
      } catch (e: unknown) {
        console.warn(
          '[生图 HTTP] /v1/images/generations 兜底失败:',
          e instanceof Error ? e.message : e
        );
      }
    }
  }

  if (!buf.length) {
    if (mode === 'openai_images') {
      throw new Error(
        `OpenAI Images 远端返回空响应体（HTTP ${httpStatus}）。请检查 URL、REMOTE_IMAGE_MODEL、以及火山鉴权 \`ARK_API_KEY\` 或 \`HEADER_AUTHORIZATION\`；若为豆包远端，请参考官方示例使用 \`/images/generations\` 且 \`IMAGE_RESPONSE_FORMAT=url\`。`
      );
    }
    const ollamaVersion = mode === 'ollama' ? await fetchOllamaVersion(endpoint) : null;
    const diag = [
      `HTTP ${httpStatus}`,
      teHdr ? `Transfer-Encoding=${teHdr}` : undefined,
      clHdr != null ? `声明 Content-Length=${clHdr}` : '无 Content-Length',
      ct ? ct : '',
      ollamaVersion ? `Ollama server=${ollamaVersion}` : undefined,
    ]
      .filter(Boolean)
      .join('；');
    console.warn('[生图 HTTP] 仍为 0 字节', {
      diag,
      endpoint: lastEmptyDiagEndpoint.slice(0, 220),
      model: mode === 'ollama' ? ollamaModel : undefined,
    });
    const modelHint =
      mode === 'ollama'
        ? `本次请求解析到的模型字段为「${ollamaModel}」；若在设置里未填 OLLAMA_MODEL，默认为 flux，必须与 \`ollama list\` 里实际存在的**出图**模型完全一致（不要把 VL 闲聊模型当成生图模型）。`
        : '';
    throw new Error(
      `生图接口响应体仍为 0 字节（${diag}）。${modelHint}` +
        `已在应用中依次尝试 /api/generate stream:false、Node 重读、stream:true（NDJSON），以及 /v1/images/generations。` +
        `这说明当前 Ollama 服务端没有通过 HTTP 返回图片数据；请升级 Ollama 服务端到支持实验生图 HTTP 返回的版本，` +
        `并确认设置里的 OLLAMA_MODEL 与 ollama list 完全一致。示例：` +
        `{"model":"x/flux2-klein:4b","prompt":"a cat","stream":false}`
    );
  }

  const utf8Full = stripUtf8Bom(buf.toString('utf8'));
  if (!utf8Full.trim() && !looksLikeBinaryImage(buf) && !ct.startsWith('image/')) {
    throw new Error(
      '生图接口响应体仅含空白或不可显示的 UTF‑8（无有效 JSON）。请检查 HTTP 接口地址是否为直连 Ollama/生图中间层，并重试。'
    );
  }

  let imageBuf: Buffer | null = null;

  /** 火山豆包：url 模式 + 流式 NDJSON 可能一次返回多张图链接 */
  const preferUrlDownload =
    mode === 'openai_images' &&
    (volcOpenAi || String(postBody.response_format ?? '').toLowerCase() === 'url');

  if (preferUrlDownload && !looksLikeBinaryImage(buf) && !ct.startsWith('image/')) {
    const urlsFromBody = collectImageUrlsFromArkStreamOrPlainJson(utf8Full);
    if (urlsFromBody.length > 0) {
      const buffers: Buffer[] = [];
      for (const u of urlsFromBody) {
        buffers.push(await fetchImageBinaryFromUrl(u, IMAGE_GEN_TIMEOUT_MS));
      }
      return writePngBuffersToOutputFiles(buffers, outputDir, params);
    }
  }

  /**
   * 百炼/万相同步协议：响应 JSON 为 { output: { results: [{ url | b64_image }] } }。
   * URL 需下载为二进制；b64_image 直接解码。支持多张。
   */
  if (providerKind === 'bailian-wanx' && !looksLikeBinaryImage(buf) && !ct.startsWith('image/')) {
    let bailianJson: unknown = null;
    try {
      bailianJson = JSON.parse(utf8Full) as unknown;
    } catch {
      /* fallthrough */
    }
    if (bailianJson) {
      const { urls, b64s } = extractImagesFromBailianResponse(bailianJson);
      if (urls.length > 0) {
        const buffers: Buffer[] = [];
        for (const u of urls) {
          buffers.push(await fetchImageBinaryFromUrl(u, IMAGE_GEN_TIMEOUT_MS));
        }
        return writePngBuffersToOutputFiles(buffers, outputDir, params);
      }
      if (b64s.length > 0) {
        const buffers: Buffer[] = [];
        for (const b of b64s) {
          const buf2 = base64FieldToImageBuffer(b);
          if (buf2) buffers.push(buf2);
        }
        if (buffers.length > 0) {
          return writePngBuffersToOutputFiles(buffers, outputDir, params);
        }
      }
    }
  }

  /**
   * MiniMax 响应：{ data: { image_urls | image_base64 }, base_resp }
   * 失败时常仅有 base_resp（HTTP 仍可能 200），必须先读 status_code。
   * 按 provider 或响应形态识别，避免自配 Endpoint/custom 时漏解析。
   */
  if (!looksLikeBinaryImage(buf) && !ct.startsWith('image/')) {
    let mmJson: unknown = null;
    try {
      mmJson = JSON.parse(utf8Full) as unknown;
    } catch {
      /* fallthrough */
    }
    if (
      mmJson &&
      (providerKind === 'minimax' || looksLikeMiniMaxResponseJson(mmJson))
    ) {
      let mmHost = '';
      try {
        mmHost = new URL(endpoint).host;
      } catch {
        mmHost = endpoint.slice(0, 80);
      }
      const mmMeta = {
        host: mmHost,
        authSource: authMeta.source,
        keyHint: authMeta.keyHint,
      };
      const { urls: mmUrls, b64s: mmB64s } = extractImagesFromMiniMaxResponse(mmJson, mmMeta);
      if (mmUrls.length > 0) {
        const buffers: Buffer[] = [];
        for (const u of mmUrls) {
          buffers.push(await fetchImageBinaryFromUrl(u, IMAGE_GEN_TIMEOUT_MS));
        }
        return writePngBuffersToOutputFiles(buffers, outputDir, params);
      }
      if (mmB64s.length > 0) {
        const buffers: Buffer[] = [];
        for (const b of mmB64s) {
          const buf2 = base64FieldToImageBuffer(b);
          if (buf2) buffers.push(buf2);
        }
        if (buffers.length > 0) {
          return writePngBuffersToOutputFiles(buffers, outputDir, params);
        }
      }
      throw new Error(
        'MiniMax 返回成功状态，但未包含 image_urls / image_base64。请确认模型为 image-01，且 Endpoint 指向 /v1/image_generation。'
      );
    }
  }

  /** 二进制图优先（任何 mode） */
  if (looksLikeBinaryImage(buf)) {
    imageBuf = buf;
  } else if (ct.startsWith('image/')) {
    imageBuf = buf;
  } else if (mode === 'raw') {
    /** 服务端仍可能返回 JSON / SSE — 再走下方解析 */
  }

  if (!imageBuf && (mode === 'sdwebui' || mode === 'ollama' || mode === 'openai_images')) {
    const jsonExtractMode =
      mode === 'openai_images' ? ('auto' as const) : (mode === 'sdwebui' ? ('sdwebui' as const) : ('ollama' as const));
    try {
      const json = JSON.parse(stripUtf8Bom(buf.toString('utf8'))) as unknown;
      imageBuf = extractImageBufferFromJson(json, jsonExtractMode);
      if (!imageBuf && mode === 'openai_images') {
        const href = extractOpenAiCompatibleImageDownloadUrl(json);
        if (href) {
          imageBuf = await fetchImageBinaryFromUrl(href, IMAGE_GEN_TIMEOUT_MS);
        }
      }
    } catch {
      /* fallthrough */
    }
    if (!imageBuf) {
      imageBuf = extractImageFromOllamaFriendlyBody(buf);
    }
  }

  if (!imageBuf && mode === 'auto') {
    if (ct.includes('json') || (buf.length > 2 && buf[0] === 0x7b)) {
      try {
        const json = JSON.parse(stripUtf8Bom(buf.toString('utf8'))) as unknown;
        imageBuf =
          extractImageBufferFromJson(json, 'sdwebui') ||
          extractImageBufferFromJson(json, 'ollama');
      } catch {
        /* ignore */
      }
    }
    /** 不显式标注 JSON 或非标准 Content-Type（仍可能是 Ollama 单包 / NDJSON / SSE） */
    if (!imageBuf) {
      imageBuf = extractImageFromOllamaFriendlyBody(buf);
    }
  }

  /** 用户误选「格式」或未识别 mode 时的最后尝试 */
  if (!imageBuf) {
    imageBuf = extractImageFromOllamaFriendlyBody(buf);
  }

  if (!imageBuf && mode === 'ollama') {
    console.warn('[生图 HTTP] /api/generate 未返回图片；改用 /v1/images/generations 再请求一次', {
      model: ollamaModel,
      endpoint: endpoint.slice(0, 220),
      bytes: buf.length,
    });
    const viaImages = await tryOllamaOpenAiImagesFallback(endpoint, ollamaModel, params, customHdr);
    if (viaImages.image) {
      imageBuf = viaImages.image;
    } else {
      console.warn('[生图 HTTP] /v1/images/generations 未返回图片', {
        detail: viaImages.detail,
      });
    }
  }

  if (!imageBuf) {
    let topKeys = '';
    try {
      const j = JSON.parse(utf8Full.trim()) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        topKeys = Object.keys(j as Record<string, unknown>)
          .slice(0, 24)
          .join(', ');
      }
    } catch {
      /* 非整块 JSON */
    }
    console.warn('[生图 HTTP] 无法解析', {
      contentType: ct,
      bytes: buf.length,
      utf8Preview: utf8Full.slice(0, 220).replace(/\s+/g, ' '),
      hexHead32: buf.subarray(0, 32).toString('hex'),
      jsonTopKeys: topKeys || undefined,
    });
    const hintKeys = topKeys ? `（已解析 JSON 顶级键：${topKeys}，其中未识别出图片字段）` : '';
    const progressOnlyHint =
      mode === 'ollama' ? summarizeOllamaProgressOnlyBody(buf) : null;
    throw new Error(
      `无法从 HTTP 响应解析图片${hintKeys}。${progressOnlyHint ? progressOnlyHint + '。' : ''}` +
        `若为 Ollama：当前服务端必须在 /api/generate 或 /v1/images/generations 返回 image/base64；` +
        `如果只返回 completed/total 进度，请升级并重启 Ollama 服务端，确认 server 版本与客户端一致。`
    );
  }

  return [await finalizeOnePngBuffer(imageBuf, outputDir, params)];
}

export {
  generateImageHttp,
  detectHttpFormat,
  buildSiblingEndpoint,
  fetchOllamaVersion,
  tryOllamaOpenAiImagesFallback,
  summarizeOllamaProgressOnlyBody,
  extractImageFromOllamaFriendlyBody,
  buildUnifiedImageRequest,
  buildImageHttpRequestViaAdapter,
  describeImageHttpAuth,
};
