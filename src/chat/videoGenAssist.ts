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
import { resolveModelConnection } from '../store/connectionStore';
import { useChatStore } from '../store/chatStore';
import { replyRunWasCancelled } from './imageTaskState';

const VIDEO_ACTION_RE = /(?:生成|制作|合成|做|出|来|录|拍).{0,24}(?:视频|短片|动图)|\b(?:generate|create|make|produce)\b.{0,40}\b(?:video|clip|mp4)\b/i;
const NEGATIVE_RE = /(?:不用|不要|别|无需|不需要).{0,8}(?:生成|制作|合成|做)?.{0,8}(?:视频|短片|动图)|\b(?:do not|don't|no need to)\b.{0,30}\b(?:video|clip)\b/i;
const DISCUSSION_RE = /(?:如何|怎么|怎样|能否|是否|能不能|可不可以).{0,24}(?:生成|制作|合成|做).{0,12}(?:视频|短片)|(?:生成|制作).{0,12}(?:视频|短片).{0,10}(?:教程|提示词|prompt|脚本|分镜|费用|收费|原理)|\b(?:how (?:to|can)|can (?:you|it)|tutorial|prompt for)\b.{0,50}\b(?:video|clip)\b/i;

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
  void replyText;
  if (hasExistingVideo) return { shouldGenerate: false, prompt: '' };
  if (!u) return { shouldGenerate: false, prompt: '' };
  if (!VIDEO_ACTION_RE.test(u)) return { shouldGenerate: false, prompt: '' };
  if (NEGATIVE_RE.test(u) || DISCUSSION_RE.test(u)) return { shouldGenerate: false, prompt: '' };
  // A prose response may contain refusal/explanation text; it is never a video brief.
  return { shouldGenerate: true, prompt: u.slice(0, 2000) };
}

export interface VideoGenResult {
  content: string;
  files: FileInfo[] | undefined;
  plannedIntent: VideoIntent;
}
const dispatched = new Set<string>();

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
  const requestKey = `${sendSessionId}:${assistantId}`;
  if (dispatched.has(requestKey) || replyRunWasCancelled(sendSessionId, userMessage.id)) return { content: rawText, files: undefined, plannedIntent: { shouldGenerate: false, prompt: '' } };
  dispatched.add(requestKey); if (dispatched.size > 1000) dispatched.delete(dispatched.values().next().value!);

  const configuredVideoModel =
    opts.videoModel ??
    (await import('../store/modelStore')).useModelStore
      .getState()
      .models.find((m) => m.isVideoGenerator && m.videoGeneratorConfig) as ModelConfig | undefined;
  if (!configuredVideoModel) {
    return { content: rawText, files: undefined, plannedIntent: intent };
  }
  const videoModel = resolveModelConnection(configuredVideoModel);

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
      files: Array.from(new Map([...(useChatStore.getState().sessions.find(s => s.id === sendSessionId)?.messages.find(m => m.id === assistantId)?.files ?? currentMsg?.files ?? []), file].map(f => [f.path, f])).values()),
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
