import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useChatStore } from '../store/chatStore';
import { useModelStore } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { useSettingStore } from '../store/settingStore';
import { useI18n } from '../hooks/useI18n';
import { useWorkspaceStore } from '../store/workspaceStore';
import { Message, ChatSession, FileInfo, ModelConfig, WebSearchProvider } from '../types';
import { FiPaperclip, FiFile, FiImage, FiSquare, FiDownload, FiGlobe } from 'react-icons/fi';
import MessageItem from './MessageItem';
import ModelSelector from './ModelSelector';
import { IosSwitch } from './IosSwitch';
import { getWebSearchQueryIfTriggered } from '../utils/webSearchTrigger';
import { extractLaunchAppNames, extractGenerateImageCalls } from '../utils/toolCalls';
import { sessionToHtml, sessionToMarkdown } from '../utils/exportChat';
import { canUseSseStream, effectiveWebEnabled } from '../utils/chatModelPolicy';

/** 工作区根目录下 MYAGENT_KNOWLEDGE.md / knowledge.md / README.md 片段 */
async function maybeInjectWorkspaceMessages(
  sessionMessages: Message[],
  userMessage: Message
): Promise<Message[]> {
  const root = useWorkspaceStore.getState().rootPath.trim();
  if (!root) return [...sessionMessages, userMessage];
  const maxChars = useWorkspaceStore.getState().maxChars;
  try {
    const r = await window.electron.readWorkspaceHint({ root, maxChars });
    if (!r.ok || !r.text) return [...sessionMessages, userMessage];
    const inj: Message = {
      id: `wsctx-${Date.now()}`,
      role: 'system',
      content: `【工作区知识文件：${r.fileName}】\n${r.text}`,
      timestamp: Date.now(),
      model: 'workspace',
    };
    return [inj, ...sessionMessages, userMessage];
  } catch {
    return [...sessionMessages, userMessage];
  }
}

/** 发送给模型时可选注入联网摘要（不写回聊天记录）；仅关键词命中或 /web 前缀时才请求检索 */
async function buildMessagesWithOptionalWebSearch(
  sessionMessages: Message[],
  userMessage: Message,
  web: { enabled: boolean; provider: WebSearchProvider; apiKey: string }
): Promise<Message[]> {
  const outgoing: Message[] = [...sessionMessages, userMessage];
  if (!web.enabled) return outgoing;

  const raw = userMessage.content.trim();
  if (!raw || raw === '（附件）') return outgoing;

  const searchQuery = getWebSearchQueryIfTriggered(raw);
  if (!searchQuery) return outgoing;

  try {
    const res = await window.electron.webSearch({
      query: searchQuery,
      provider: web.provider,
      apiKey: web.apiKey || undefined,
    });
    let snippet = (res.text || '').trim();
    if (!snippet) {
      const hint =
        res.error || '第三方摘要接口未返回正文（DuckDuckGo 等对中文即时新闻常为空）。';
      snippet = [
        `用户已通过「搜索类」关键词请求联网参考，检索词：「${searchQuery}」。`,
        hint,
        '请仍给出可核查的要点提纲或领域框架；涉及时效须写明可能非当日头条，并建议对照央视新闻、人民网、新华网等核实。',
      ].join('\n');
    }

    const preamble =
      '【重要 · 联网模式】MyAgent 已在用户发送前执行联网检索。你必须遵守：\n' +
      '1）禁止用「无法联网」「没有实时联网能力」「不能获取最新资讯」等作为主要回答来推脱；\n' +
      '2）若下方有检索摘要，请优先概括摘要并尽量列出来源标题或链接；\n' +
      '3）若无有效摘要，请结合检索词与常识给出「要闻类型 / 关注方向」等结构化梳理，并明确标注「非实时抓取、具体事件需查权威媒体当日版面」。\n\n' +
      `【检索词】「${searchQuery}」\n\n` +
      '【检索摘要 / 说明】\n';

    const inject: Message = {
      id: `webctx-${Date.now()}`,
      role: 'system',
      content: preamble + snippet,
      timestamp: Date.now(),
      model: 'web-search',
    };
    return [inject, ...sessionMessages, userMessage];
  } catch (e) {
    console.warn('联网搜索失败', e);
    const inject: Message = {
      id: `webctx-${Date.now()}`,
      role: 'system',
      content:
        '【重要 · 联网模式】检索接口报错，但用户已发起联网类请求。禁止仅用「无法联网」推脱。\n' +
        '错误信息：' +
        (e instanceof Error ? e.message : String(e)) +
        `\n检索词：「${searchQuery}」。请说明本次检索失败，并仍基于常识给出可核查的参考方向（涉及时效请提醒用户查阅权威媒体）。`,
      timestamp: Date.now(),
      model: 'web-search',
    };
    return [inject, ...sessionMessages, userMessage];
  }
}

async function buildOutgoingChain(
  historyWithoutUser: Message[],
  userMessage: Message,
  web: { enabled: boolean; provider: WebSearchProvider; apiKey: string }
): Promise<Message[]> {
  const withWs = await maybeInjectWorkspaceMessages(historyWithoutUser, userMessage);
  const hist = withWs.slice(0, -1);
  const last = withWs[withWs.length - 1];
  return buildMessagesWithOptionalWebSearch(hist, last, web);
}

async function postProcessAssistantContent(
  responseContent: string,
  activeModel: ModelConfig,
  imageIndexBase: number,
  setInlineImageIndex: React.Dispatch<React.SetStateAction<number>>
): Promise<{ content: string; files?: FileInfo[] }> {
  let text = responseContent;

  const launches = extractLaunchAppNames(text);
  for (const { name, raw } of launches) {
    try {
      await window.electron.launchApp(name);
      text = text.replace(raw, `\n*[系统提示: 已尝试启动应用 ${name}]*\n`);
    } catch {
      text = text.replace(raw, `\n*[系统提示: 启动应用 ${name} 失败]*\n`);
    }
  }

  const imageCalls = extractGenerateImageCalls(text);
  const resolveImageGeneratorModel = (): ModelConfig | undefined => {
    if (activeModel?.isImageGenerator && activeModel.imageGeneratorConfig) return activeModel;
    return useModelStore.getState().models.find((m) => m.isImageGenerator && m.imageGeneratorConfig);
  };
  const imgGenModel = resolveImageGeneratorModel();
  const generatedFiles: Array<{ path: string; url: string; width: number; height: number }> = [];

  for (const match of imageCalls) {
    const { prompt, width, height, raw } = match;
    if (!imgGenModel?.imageGeneratorConfig) {
      text = text.replace(
        raw,
        `\n*[系统提示: 未配置生图——请在「设置 → 模型配置」中添加模型，勾选「生图工具」并填写 CLI 可执行文件或 HTTP 生图接口]*\n`
      );
      continue;
    }
    try {
      const result = await window.electron.generateImage({
        prompt,
        width,
        height,
        modelId: imgGenModel.id,
        imageGeneratorConfig: imgGenModel.imageGeneratorConfig,
      });
      generatedFiles.push(result);
      text = text.replace(raw, `\n*[系统提示: 已为您生成图片，见下方附件]*\n`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      text = text.replace(raw, `\n*[系统提示: 图片生成失败 - ${msg}]\n`);
    }
  }

  let files: FileInfo[] | undefined;
  if (generatedFiles.length > 0) {
    const fs = await import('fs');
    const fileInfos: FileInfo[] = await Promise.all(
      generatedFiles.map(async (f, i) => {
        const fsStats = await fs.promises.stat(f.path);
        return {
          name: `generated_${imageIndexBase + i + 1}.png`,
          path: f.path,
          type: 'image/png',
          size: fsStats.size,
        };
      })
    );
    setInlineImageIndex((prev) => prev + generatedFiles.length);
    files = fileInfos;
  }

  return { content: text, files };
}

const ChatWindow: React.FC<{ footerH?: number }> = ({ footerH = 76 }) => {
  const {
    currentSessionId,
    sessions,
    addMessage,
    updateMessage,
    appendToMessage,
    loadingSessionId,
    setLoadingSession,
    clearLoadingForSession,
    updateSessionTitle,
    setSessionWebOverride,
  } = useChatStore();

  const webSearchEnabled = useWebSearchStore((s) => s.enabled);
  const { t, locale: uiLocale } = useI18n();

  const isCurrentSessionLoading =
    loadingSessionId !== null && loadingSessionId === currentSessionId;
  const { getActiveModel } = useModelStore();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevMsgCountRef = useRef(0);
  const [inlineImageIndex, setInlineImageIndex] = useState(0);
  const inlineImageIndexRef = useRef(0);
  inlineImageIndexRef.current = inlineImageIndex;
  const [isStreaming, setIsStreaming] = useState(false);
  const streamUnsubRef = useRef<(() => void) | null>(null);
  const streamHadErrorRef = useRef(false);
  const streamingAssistantIdRef = useRef<string | null>(null);

  const currentSession = sessions.find((s: ChatSession) => s.id === currentSessionId);
  const messages = currentSession?.messages || [];

  const runModelReply = useCallback(
    async (sendSessionId: string, historyBeforeUser: Message[], userMessage: Message, activeModel: ModelConfig) => {
      const session = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
      const webState = useWebSearchStore.getState();
      const webOn = effectiveWebEnabled(session, webState.enabled);

      let chain: Message[];
      try {
        chain = await buildOutgoingChain(historyBeforeUser, userMessage, {
          enabled: webOn,
          provider: webState.provider,
          apiKey: webState.apiKey,
        });
      } catch (e) {
        console.error(e);
        addMessage(sendSessionId, {
          id: `${Date.now()}-err`,
          role: 'assistant',
          content: t('chat.buildFailed') + (e instanceof Error ? e.message : String(e)),
          timestamp: Date.now(),
          model: activeModel.name,
        });
        clearLoadingForSession(sendSessionId);
        return;
      }

      const plainMessages = JSON.parse(JSON.stringify(chain)) as Message[];
      const plainModel = JSON.parse(JSON.stringify(activeModel)) as ModelConfig;
      const useStream = useSettingStore.getState().streamResponses && canUseSseStream(activeModel);

      if (useStream) {
        streamHadErrorRef.current = false;
        const assistantId = `${Date.now()}-a`;
        streamingAssistantIdRef.current = assistantId;
        setIsStreaming(true);
        addMessage(sendSessionId, {
          id: assistantId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          model: activeModel.name,
        });

        const imgBase = inlineImageIndexRef.current;
        const unsub = window.electron.subscribeModelStream(plainMessages, plainModel, {
          onDelta: (d) => appendToMessage(sendSessionId, assistantId, d),
          onError: (m) => {
            streamHadErrorRef.current = true;
            updateMessage(sendSessionId, assistantId, { content: m });
          },
          locale: uiLocale,
          onEnd: () => {
            void (async () => {
              streamUnsubRef.current = null;
              if (streamHadErrorRef.current) {
                setIsStreaming(false);
                clearLoadingForSession(sendSessionId);
                streamingAssistantIdRef.current = null;
                return;
              }
              const msg = useChatStore.getState()
                .sessions.find((s) => s.id === sendSessionId)
                ?.messages.find((m) => m.id === assistantId);
              const raw = msg?.content ?? '';
              try {
                const { content, files } = await postProcessAssistantContent(
                  raw,
                  activeModel,
                  imgBase,
                  setInlineImageIndex
                );
                updateMessage(sendSessionId, assistantId, { content, files: files as Message['files'] });
              } catch (e) {
                updateMessage(sendSessionId, assistantId, {
                  content: raw + '\n\n' + t('postProcess.tag') + (e instanceof Error ? e.message : String(e)),
                });
              } finally {
                setIsStreaming(false);
                clearLoadingForSession(sendSessionId);
                streamingAssistantIdRef.current = null;
              }
            })();
          },
        });
        streamUnsubRef.current = unsub;
        return;
      }

      try {
        const response = await window.electron.callModel(plainMessages, plainModel, { locale: uiLocale });
        const content0 = response.content || t('chat.fallbackReply');
        const { content: c, files } = await postProcessAssistantContent(
          content0,
          activeModel,
          inlineImageIndexRef.current,
          setInlineImageIndex
        );
        addMessage(sendSessionId, {
          id: `${Date.now() + 1}-a`,
          role: 'assistant',
          content: c,
          files: files as Message['files'],
          timestamp: Date.now(),
          model: activeModel.name,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        addMessage(sendSessionId, {
          id: `${Date.now()}-a`,
          role: 'assistant',
          content: t('chat.requestFailed') + msg,
          timestamp: Date.now(),
          model: activeModel.name,
        });
      } finally {
        clearLoadingForSession(sendSessionId);
      }
    },
    [addMessage, appendToMessage, clearLoadingForSession, updateMessage, t, uiLocale]
  );

  const handleStop = () => {
    window.electron.closeModelStream();
    streamUnsubRef.current?.();
    streamUnsubRef.current = null;
    setIsStreaming(false);
    const sid = currentSessionId;
    const aid = streamingAssistantIdRef.current;
    if (sid && aid) {
      const msg = useChatStore.getState().sessions.find((s) => s.id === sid)?.messages.find((m) => m.id === aid);
      if (msg) {
        updateMessage(sid, aid, {
          content: msg.content ? `${msg.content}\n\n${t('chat.stopped')}` : t('chat.stopped'),
        });
      }
      streamingAssistantIdRef.current = null;
    }
    if (sid) clearLoadingForSession(sid);
  };

  const handleResend = async (message: Message) => {
    const activeModel = getActiveModel();
    if (!activeModel || !currentSessionId) return;
    if (useChatStore.getState().loadingSessionId === currentSessionId) return;

    const sendSessionId = currentSessionId;
    setLoadingSession(sendSessionId);
    const priorMessages = messages;
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: message.content,
      files: message.files,
      timestamp: Date.now(),
      model: activeModel.name,
    };
    addMessage(currentSessionId, userMessage);
    await runModelReply(sendSessionId, priorMessages, userMessage, activeModel);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      const files = Array.from(e.dataTransfer.files);
      setAttachments((prev) => [...prev, ...files]);
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          setAttachmentPreviews((p) => ({ ...p, [f.name]: url }));
        }
      }
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files as FileList);
      setAttachments((prev) => [...prev, ...files]);
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          setAttachmentPreviews((p) => ({ ...p, [f.name]: url }));
        }
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (index: number) => {
    const removed = attachments[index];
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    if (removed && removed.name in attachmentPreviews) {
      URL.revokeObjectURL(attachmentPreviews[removed.name]);
      setAttachmentPreviews((p) => {
        const np = { ...p };
        delete np[removed.name];
        return np;
      });
    }
  };

  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    return () => {
      Object.values(attachmentPreviews).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [attachmentPreviews]);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electron : undefined;
    if (!api?.onMessage) return;
    const off = api.onMessage('myagent-clipboard-paste', (clip: string) => {
      const c = String(clip ?? '');
      if (!c) return;
      setInput((prev) => (prev ? `${prev}\n${c}` : c));
    });
    return off;
  }, []);

  const handleExport = async (kind: 'md' | 'html') => {
    if (!currentSession) return;
    const content = kind === 'md' ? sessionToMarkdown(currentSession) : sessionToHtml(currentSession);
    const ext = kind === 'md' ? 'md' : 'html';
    const safe = (currentSession.title || 'export').replace(/[\\/:"*?<>|]/g, '_');
    await window.electron.saveTextFile({
      defaultName: `${safe}.${ext}`,
      content,
      filters:
        kind === 'md'
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : [{ name: 'HTML', extensions: ['html', 'htm'] }],
    });
  };

  const handleSend = async () => {
    if ((!input.trim() && attachments.length === 0) || !currentSessionId) return;
    if (useChatStore.getState().loadingSessionId === currentSessionId) return;

    const activeModel = getActiveModel();
    if (!activeModel) {
      alert(t('chat.configureModel'));
      return;
    }

    const sendSessionId = currentSessionId;
    setLoadingSession(sendSessionId);
    const priorMessages = messages;
    const uploadedFiles: FileInfo[] = [];

    if (attachments.length > 0) {
      for (const file of attachments) {
        try {
          const buffer = await file.arrayBuffer();
          const info = await window.electron.uploadFile({
            name: file.name,
            buffer: Array.from(new Uint8Array(buffer)),
            type: file.type,
            size: file.size,
          });
          uploadedFiles.push(info);
        } catch (e) {
          console.error('上传附件失败', e);
        }
      }
    }

    const att = t('chat.attachment');
    const textContent = input.trim() || (uploadedFiles.length > 0 ? att : '');

    if (messages.length === 0) {
      const title = (textContent === att ? t('chat.attachmentTitle') : textContent) || t('session.newTitle');
      updateSessionTitle(
        currentSessionId,
        title.length > 15 ? title.substring(0, 15) + '...' : title
      );
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: textContent,
      files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
      timestamp: Date.now(),
      model: activeModel.name,
    };

    addMessage(currentSessionId, userMessage);
    setInput('');
    setAttachments([]);
    setAttachmentPreviews({});

    await runModelReply(sendSessionId, priorMessages, userMessage, activeModel);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    e.preventDefault();
    void handleSend();
  };

  const webEffective =
    currentSession != null
      ? effectiveWebEnabled(currentSession, webSearchEnabled)
      : false;

  const attachmentStripH = 80;

  /** 非流式：最后一条是用户时显示；流式：插入空助手后最后一条是助手且无正文时也要显示，直到首包到达 */
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const showTypingDots =
    isCurrentSessionLoading &&
    (lastMsg?.role === 'user' ||
      (isStreaming && lastMsg?.role === 'assistant' && !(lastMsg.content ?? '').trim().length));

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {currentSessionId && currentSession && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-stone-600/20 px-6 py-2 dark:border-white/10 bg-stone-100/50 dark:bg-slate-900/40">
          <div className="flex items-center gap-2.5 text-xs text-stone-600 dark:text-slate-400">
            <div className="flex items-center gap-1.5">
              <FiGlobe size={14} className="shrink-0" aria-hidden />
              <span>{t('chat.web')}</span>
            </div>
            <IosSwitch
              checked={webEffective}
              aria-label={t('chat.webSwitch')}
              onChange={(v) => setSessionWebOverride(currentSessionId, v ? 'on' : 'off')}
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleExport('md')}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
              title={t('chat.export.md')}
            >
              <FiDownload size={14} /> MD
            </button>
            <button
              type="button"
              onClick={() => void handleExport('html')}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
              title={t('chat.export.html')}
            >
              <FiDownload size={14} /> HTML
            </button>
          </div>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto px-8 py-4 space-y-4"
        style={{
          paddingBottom: footerH + (attachments.length > 0 ? attachmentStripH : 0),
        }}
      >
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-64 text-stone-400 dark:text-slate-500">
            <p className="text-lg">{t('chat.emptyChat')}</p>
          </div>
        )}

        {messages.map((message) => {
          const hideEmptyStreamBubble =
            isStreaming &&
            message.role === 'assistant' &&
            message.id === streamingAssistantIdRef.current &&
            !(message.content ?? '').trim().length;
          if (hideEmptyStreamBubble) return <React.Fragment key={message.id} />;
          return (
            <MessageItem
              key={message.id}
              message={message}
              onResend={message.role === 'user' ? handleResend : undefined}
            />
          );
        })}

        {showTypingDots && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 text-stone-500 dark:text-slate-500 text-sm px-5 py-3.5 bg-stone-100 dark:bg-slate-800 rounded-2xl rounded-tl-sm border border-stone-300/45 dark:border-white/5">
              <div className="flex gap-1">
                <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
                  ·
                </span>
                <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
                  ·
                </span>
                <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
                  ·
                </span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {isDragging && (
        <div className="fixed inset-0 z-50 bg-primary-500/10 backdrop-blur-sm flex items-center justify-center border-4 border-dashed border-primary-400 m-4 rounded-2xl">
          <p className="text-2xl font-bold text-primary-600 dark:text-primary-400">{t('chat.dropHint')}</p>
        </div>
      )}

      <div
        className="fixed bottom-0 right-0 z-30 flex w-[calc(100%-256px)] min-w-0 flex-col bg-transparent"
        style={{ left: 256 }}
      >
        {attachments.length > 0 && (
          <div
            className="flex shrink-0 flex-wrap justify-start gap-2 border-b border-stone-600/25 bg-transparent px-6 py-1.5 dark:border-white/10"
            aria-label={t('chat.attachments')}
          >
            {attachments.map((file, index) => {
              const preview = attachmentPreviews[file.name];
              const isImage = file.type.startsWith('image/');
              const showThumb = isImage && !!preview;
              return (
                <div
                  key={`${file.name}-${index}`}
                  className="relative flex w-[92px] shrink-0 flex-col items-center gap-1 rounded-lg border border-primary-400/55 bg-transparent px-1 pb-1.5 pt-1 dark:border-primary-500/45"
                >
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-stone-400/50 bg-stone-100 text-[11px] leading-none text-stone-600 shadow-sm hover:bg-stone-200 dark:border-white/20 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                    title={t('chat.removeFile')}
                  >
                    ×
                  </button>
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 border-primary-500/70 bg-stone-100/80 shadow-sm dark:border-primary-400/60 dark:bg-slate-900/40">
                    {showThumb ? (
                      <img src={preview} alt="" className="h-full w-full object-cover" />
                    ) : isImage ? (
                      <FiImage className="text-stone-400 dark:text-slate-500" size={22} aria-hidden />
                    ) : (
                      <FiFile className="text-stone-600 dark:text-slate-300" size={22} aria-hidden />
                    )}
                  </div>
                  <span className="w-full truncate px-0.5 text-center text-[10px] font-medium leading-tight text-stone-800 dark:text-slate-100">
                    {file.name}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div
          className="relative box-border flex min-h-0 w-full min-w-0 items-center border-t border-stone-600/38 bg-stone-200/92 px-6 py-2 backdrop-blur-xl dark:border-white/10 dark:bg-[#0B1120]/80"
          style={{ minHeight: footerH }}
        >
          {(() => {
            const totalLength = messages.reduce((acc, m) => acc + m.content.length, 0) + input.length;
            const limit = 20000;
            const fillPerc = Math.min((totalLength / limit) * 100, 100);
            const isNearLimit = fillPerc > 80;
            return totalLength > 0 ? (
              <div
                className={`absolute top-0 left-0 h-[2px] transition-all duration-300 ${
                  isNearLimit ? 'bg-orange-500' : 'bg-gradient-to-r from-primary-400 to-teal-500'
                }`}
                style={{ width: `${fillPerc}%` }}
              />
            ) : null;
          })()}

          <input type="file" multiple ref={fileInputRef} onChange={handleFileInput} className="hidden" />

          <div className="flex w-full min-w-0 items-center gap-2">
            <div className="flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-2xl border border-stone-400/28 bg-stone-100/95 py-0 pl-1.5 pr-1 shadow-sm transition-all focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/50 dark:border-slate-700 dark:bg-slate-800/80">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all ${
                  attachments.length > 0
                    ? 'bg-primary-100/80 text-primary-600 dark:bg-primary-900/30'
                    : 'text-stone-500 hover:bg-stone-300/45 dark:text-slate-500 dark:hover:bg-slate-700'
                }`}
                title={t('chat.uploadFile')}
              >
                <FiPaperclip size={14} />
              </button>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={t('chat.inputPlaceholder')}
                className="box-border min-h-10 w-full min-w-0 flex-1 resize-none bg-transparent py-2.5 pl-1 pr-0.5 leading-5 text-stone-800 placeholder-stone-500/70 focus:outline-none dark:text-slate-100 text-[clamp(0.8125rem,0.55vw+0.68rem,0.9375rem)]"
                rows={1}
                style={{ maxHeight: 'min(28vh, 9rem)' }}
                disabled={isCurrentSessionLoading}
              />
              <div className="ml-0.5 flex shrink-0 items-center self-stretch border-l border-stone-400/25 pl-1 dark:border-slate-600">
                <ModelSelector compact />
              </div>
            </div>
            {isCurrentSessionLoading && isStreaming ? (
              <button
                type="button"
                onClick={handleStop}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-xl border border-stone-400/50 bg-stone-100 px-4 text-sm font-medium text-stone-800 hover:bg-stone-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                title={t('chat.stopTitle')}
              >
                <FiSquare size={12} className="shrink-0" />
                {t('chat.stop')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!input.trim() && attachments.length === 0}
              className={`inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-5 text-sm font-medium transition-all ${
                input.trim() || attachments.length > 0
                  ? 'bg-primary-600 text-white shadow-md shadow-primary-500/20 hover:bg-primary-700'
                  : 'cursor-not-allowed bg-stone-300 text-stone-500 dark:bg-slate-700 dark:text-slate-500'
              }`}
              title={t('chat.sendTitle')}
            >
              {t('chat.send')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatWindow;
