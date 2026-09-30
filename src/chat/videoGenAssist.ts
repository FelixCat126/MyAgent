/**
 * 视频生成意图检测 + 客户端代理触发。
 *
 * v1 策略：不接 model tool call XML 解析（不动 system prompt），改为从 user message
 * 反推意图——用户明确请求"做视频/生成视频/出个短视频"且回复里无视频附件时，
 * 自动调 IPC 生成视频并把结果塞进 message.files。
 *
 * 后续接入真 tool call 时，本函数退化为 fallback。
 */

import type { ModelConfig, Message, FileInfo } from '../types';
import type { RunModelReplyUi } from './runModelReplyTypes';
import { stripGenerateImageArtifactsForDisplay } from '../utils/toolCalls';

const VIDEO_NOUN_RE = /(视频|短视频|短片|动图|video|clip|mp4)/i;
/** 必须是明确的"请求生成"动词 + 视频名词的组合；纯描述（"这个视频很好看"）不触发 */
const VIDEO_ACTION_RE = /(做个?|生成|出个?|来段|录个?|拍个?|制作|合成|帮我)/i;
const NEGATIVE_RE = /(不用|不要|算了|别|无需|不需要|不要了)/;

export type VideoIntent = {
  shouldGenerate: boolean;
  prompt: string;
};

export function planAssistantVideoIntent(
  userText: string,
  replyText: string,
  hasExistingVideo: boolean
): VideoIntent {
  const u = String(userText || '').trim();
  const r = String(replyText || '').trim();
  if (hasExistingVideo) return { shouldGenerate: false, prompt: '' };
  if (!u) return { shouldGenerate: false, prompt: '' };
  /** 必须「动作动词 + 视频名词」同时命中：纯描述（"这个视频很好看"）不会同时命中 */
  if (!VIDEO_NOUN_RE.test(u)) return { shouldGenerate: false, prompt: '' };
  if (!VIDEO_ACTION_RE.test(u)) return { shouldGenerate: false, prompt: '' };
  /** 否定词在视频词附近（同句）时取消；宽松实现：整句含否定则不生成 */
  if (NEGATIVE_RE.test(u)) return { shouldGenerate: false, prompt: '' };
  const cleaned = stripGenerateImageArtifactsForDisplay(r);
  return { shouldGenerate: true, prompt: cleaned.slice(0, 2000) };
}

export interface VideoGenResult {
  content: string;
  files: FileInfo[] | undefined;
  plannedIntent: VideoIntent;
}

export async function runVideoPostProcess(opts: {
  ui: RunModelReplyUi;
  sendSessionId: string;
  assistantId: string;
  rawText: string;
  userMessage: Message;
  activeModel: ModelConfig;
  historyBeforeUser: Message[];
  /** 外部传入当前 message（避免 videoGenAssist 直接耦合 chatStore） */
  currentMsg?: Message;
  /** 外部传入 video model（modelStore 第一个 isVideoGenerator=true）；未传则从 store 取 */
  videoModel?: ModelConfig;
}): Promise<VideoGenResult> {
  const {
    ui,
    sendSessionId,
    assistantId,
    rawText,
    userMessage,
    currentMsg,
  } = opts;

  const hasExistingVideo = Boolean(
    currentMsg?.files?.some((f) => f.type.startsWith('video/'))
  );

  const intent = planAssistantVideoIntent(userMessage.content, rawText, hasExistingVideo);
  if (!intent.shouldGenerate) return { content: rawText, files: undefined, plannedIntent: intent };

  const videoModel =
    opts.videoModel ??
    (await import('../store/modelStore')).useModelStore
      .getState()
      .models.find((m) => m.isVideoGenerator && m.videoGeneratorConfig) as ModelConfig | undefined;
  if (!videoModel) {
    return { content: rawText, files: undefined, plannedIntent: intent };
  }

  const fileBaseName = `video-${assistantId.slice(0, 8)}`;
  try {
    const electron = (window as { electron?: { generateVideo?: Function } }).electron;
    if (!electron?.generateVideo) {
      return { content: rawText, files: undefined, plannedIntent: intent };
    }
    /** 先在消息末尾追加「生成中」提示（不覆盖正文） */
    ui.updateMessage(sendSessionId, assistantId, {
      content: `${rawText}\n\n_🎬 视频生成中…_`,
    });
    const result = (await electron.generateVideo(
      {
        modelId: videoModel.id,
        prompt: intent.prompt,
        videoGeneratorConfig: videoModel.videoGeneratorConfig,
        streamRequestId: `vid-${assistantId}`,
      },
      {
        onProgress: (p: { status: string; message?: string }) => {
          if (p.status === 'polling' || p.status === 'started') {
            ui.updateMessage(sendSessionId, assistantId, {
              content: `${rawText}\n\n_🎬 视频生成中：${p.message || '排队中'}_`,
            });
          }
        },
      }
    )) as { ok: boolean; localPath?: string; error?: string };

    if (!result.ok || !result.localPath) {
      /** 失败：去掉「生成中」提示，追加失败说明 */
      ui.updateMessage(sendSessionId, assistantId, {
        content: `${rawText}\n\n_⚠️ 视频生成失败：${result.error || '未知'}_`,
      });
      return {
        content: `${rawText}\n\n_⚠️ 视频生成失败：${result.error || '未知'}_`,
        files: undefined,
        plannedIntent: intent,
      };
    }
    const size = await getFileSizeSafe(result.localPath);
    const file: FileInfo = {
      name: `${fileBaseName}.mp4`,
      path: result.localPath,
      type: 'video/mp4',
      size,
    };
    /** 成功：恢复纯正文（去掉「生成中」），视频作为附件追加（files 由 chatStore merge） */
    ui.updateMessage(sendSessionId, assistantId, {
      content: rawText,
      files: [file],
    });
    return {
      content: rawText,
      files: [file],
      plannedIntent: intent,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ui.updateMessage(sendSessionId, assistantId, {
      content: `${rawText}\n\n_⚠️ 视频生成异常：${msg}_`,
    });
    return {
      content: `${rawText}\n\n_⚠️ 视频生成异常：${msg}_`,
      files: undefined,
      plannedIntent: intent,
    };
  }
}

async function getFileSizeSafe(path: string): Promise<number> {
  /** 渲染端无 fs 权限——通过专用 IPC 拿大小（主进程已校验 local-file 白名单） */
  try {
    const electron = (window as { electron?: { getLocalFileSize?: (p: string) => Promise<{ ok: boolean; size?: number; error?: string }> } }).electron;
    if (electron?.getLocalFileSize) {
      const r = await electron.getLocalFileSize(path);
      return r.ok ? (r.size ?? 0) : 0;
    }
  } catch {
    /* ignore */
  }
  return 0;
}
