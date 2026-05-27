import type { Locale } from '../i18n/types';
import type { FileInfo, KnowledgeEmbedConfig, Message, ModelConfig } from '../types';
import { useKnowledgeStore } from '../store/knowledgeStore';
import { useSettingStore } from '../store/settingStore';
import {
  executeWebBrowseIntent,
  executeWebPageDescribe,
  buildWebBrowseMissingUrlMessage,
  extractUrlFromUserText,
  isSimpleWebBrowseOnly,
  needsWebAgentWorkflow,
  parseWebBrowseIntent,
  resolveWebBrowseOpenUrl,
  userWantsWebFirstImage,
  userWantsWebPageDescription,
  looksLikeWebBrowseRequest,
} from './webBrowseIntent';
import {
  agentBrowserOpen,
  agentBrowserExtractFirstImage,
  BAIDU_FIRST_IMAGE_EXTRACT_SIG,
} from './browser/agentBrowserController';
import { useAgentBrowserStore } from '../store/agentBrowserStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { buildAgentCapabilitySystem } from './systemPrompts';
import { callModelAgentRound } from './callModelAgentRound';
import {
  answerDriftsFromUserTopic,
  answerLooksLikeCommentary,
  buildAgentChainMessages,
  buildEmptyLocalSearchFallbackDisplay,
  expandTopicSynonyms,
  extractLocalSearchQuery,
  localSearchResultLooksEmpty,
  looksLikeLocalFileAgentRequest,
  looksLikeLocalImageFindRequest,
  modelDefersLocalFileWorkToUser,
  parseMaxImageAttachCount,
  userRequestsExcerpt,
} from './localFileIntent';
import {
  extractAgentLocalToolCalls,
  stripAgentLocalToolArtifacts,
  toolCallSignature,
} from './parseAgentTools';
import { executeAgentLocalTool, findLocalImagesByKeyword, runAgentLocalToolBatch } from './tools/localTools';
import type { AgentLocalToolContext } from './tools/localTools';

const MAX_AGENT_ROUNDS = 10;

function pickBestCachedToolBody(cache: Map<string, string>): string | null {
  for (const prefix of ['web_eval:', 'web_read:', 'web_open:'] as const) {
    for (const [sig, body] of [...cache.entries()].reverse()) {
      if (sig.startsWith(prefix) && body.trim()) return body;
    }
  }
  return null;
}

function buildAgentExhaustedDisplay(
  cache: Map<string, string>,
  locale: Locale
): string {
  const body = pickBestCachedToolBody(cache);
  if (!body) {
    return locale === 'en'
      ? 'Local agent reached the maximum tool rounds. Please try a simpler request.'
      : '本机 Agent 已达到工具调用轮次上限，请简化问题后重试。';
  }
  const trimmed = body.slice(0, 3500);
  return locale === 'en'
    ? `Tool round limit reached; below is the latest page data already fetched (duplicate steps were skipped):\n\n${trimmed}`
    : `已达工具轮次上限；以下为已获取的页面信息（重复操作已跳过）：\n\n${trimmed}`;
}

export type AgentLoopResult = {
  handled: boolean;
  displayText?: string;
  reasoning?: string;
  exportFiles?: FileInfo[];
};

export type RunAgentLoopArgs = {
  chatSessionId: string;
  chainMessages: Message[];
  model: ModelConfig;
  userText: string;
  locale: Locale;
  /** 流式思维片段（模型 reasoning 通道；不含检索状态文案） */
  onThinkingDelta?: (chunk: string) => void;
  /** 模型开始输出 content 流（用于延迟展示思考 UI） */
  onContentDelta?: (chunk: string) => void;
  /** 最终自然语言回复就绪（供 ChatWindow 写入正文 + 驱动点阵 replying） */
  onReplyContent?: (text: string) => void;
};

function buildUserTaskAnchor(userText: string, locale: Locale): Message {
  const isExcerpt = userRequestsExcerpt(userText);
  const isLocalImageFind = looksLikeLocalImageFindRequest(userText);
  const isWebWorkflow = needsWebAgentWorkflow(userText);
  const webWorkflowStrict =
    locale === 'en'
      ? '\nWEB TASK: The system may have already web_opened the page — do NOT repeat web_open for the same URL. ' +
        'Call each distinct tool at most once; after web_read/web_eval succeeds, answer in plain language — no more tool JSON.'
      : '\n【网页任务】系统可能已预先打开页面，禁止对同一 URL 重复 web_open。' +
        '每种不同工具最多调用一次；web_read/web_eval 已有结果后必须用自然语言回答，禁止再循环输出相同 JSON。';
  const excerptStrict =
    locale === 'en'
      ? '\nEXCERPT MODE: Output ONLY the original sentence/snippet you copy from the file. ' +
        'No commentary, no evaluation, no suggestion, no improvement, no summary, no headline, ' +
        'no preface, no "this passage describes...", no quotes around the snippet — just the raw sentence.'
      : '\n【摘录模式】只输出你从原文中复制出的那一句/那一段，**禁止**任何评价、点评、建议、改进、总结、解释、引言、说明、加引号、"这段描述…"之类的前后语。' +
        '只输出那一句原文本身，整条消息长度应≤所要求的字数。';
  const imageFindStrict =
    locale === 'en'
      ? '\nLOCAL IMAGE FIND: Search existing photos on disk with local_search mode "image". ' +
        'Do NOT call AI image generation. Images found will be attached automatically; reply briefly (one sentence).'
      : '\n【本机找图】用户要的是磁盘里**已有**的照片，请用 local_search 且 mode 设为 image 检索；' +
        '禁止 AI 生图/绘制。命中的图片会自动贴到回复里，你只需用一句话说明找到了几张。';

  return {
    id: `agent-task-${Date.now()}`,
    role: 'system',
    content:
      locale === 'en'
        ? `[Current task — answer ONLY this request]\n${userText}\n` +
          'Do not continue unrelated topics from earlier chat. Use local_search/local_read tool results; ' +
          'if excerpting, quote ≤30 Chinese chars from the file you actually read.' +
          (isExcerpt ? excerptStrict : '') +
          (isLocalImageFind ? imageFindStrict : '') +
          (isWebWorkflow ? webWorkflowStrict : '')
        : `【当前任务——仅回答以下请求，勿续写无关话题】\n${userText}\n` +
          '先前对话若与本轮检索无关请忽略。须基于 local_search / local_read 工具结果作答；' +
          '若用户要求摘录，只能引用你实际读到的文件原文，且不超过 30 字。' +
          (isExcerpt ? excerptStrict : '') +
          (isLocalImageFind ? imageFindStrict : '') +
          (isWebWorkflow ? webWorkflowStrict : ''),
    timestamp: Date.now(),
    model: 'agent-task',
  };
}

function toolResultMessage(toolName: string, body: string): Message {
  return {
    id: `agent-tool-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    role: 'system',
    content: `【工具 ${toolName} 结果】\n${body}`,
    timestamp: Date.now(),
    model: 'agent-tool',
  };
}

function autoSearchSystemMessage(
  query: string,
  body: string,
  locale: Locale,
  candidateDirs?: string
): Message {
  const empty = localSearchResultLooksEmpty(body);
  const candidateBlock = candidateDirs
    ? locale === 'en'
      ? `\n\n[System pre-listed candidate directories — pick a likely file and call local_read with the FULL "~/Documents/..." path. Do NOT ask the user.]\n${candidateDirs}`
      : `\n\n【系统已预先列出候选目录——请挑选最可能命中的文件，直接用 \`~/Documents/...\` 完整路径 local_read，禁止再向用户要文档名】\n${candidateDirs}`
    : '';
  const emptyHint = empty
    ? locale === 'en'
      ? '\n\nNo direct filename hits. Use the candidate directories above; pick the most relevant file (e.g. matching topic synonyms) and call local_read. Only after that, if still empty, say you could not find it.'
      : '\n\n文件名检索未命中：请从上面列出的候选目录中挑选最相关的文件（例如同义词命中、目录名相关）调用 local_read 读取正文，仍找不到再说明未找到。'
    : '';

  return {
    id: `agent-auto-search-${Date.now()}`,
    role: 'system',
    content:
      (locale === 'en'
        ? `[System ran local_search]\nQuery: ${query}\n${body}\n\nAnswer the user from these hits. Do NOT ask for filenames or uploads.${candidateBlock}${emptyHint}`
        : `【系统已自动执行 local_search】\n查询：${query}\n${body}\n\n请直接根据以上结果回答用户，禁止再要求提供文档名或上传文件。${candidateBlock}${emptyHint}`) + '',
    timestamp: Date.now(),
    model: 'agent-auto-search',
  };
}

async function runAutoSearch(
  userText: string,
  ctx: AgentLocalToolContext,
  embed: KnowledgeEmbedConfig | null,
  locale: Locale
): Promise<{ message: Message; empty: boolean } | null> {
  if (!looksLikeLocalFileAgentRequest(userText)) return null;
  const query = extractLocalSearchQuery(userText);
  if (!query) return null;

  let body = await executeAgentLocalTool(
    { tool: 'local_search', query, mode: 'filename', raw: '{}' },
    ctx,
    embed
  );

  if (localSearchResultLooksEmpty(body) && ctx.workspaceRoot && embed) {
    const semanticBody = await executeAgentLocalTool(
      { tool: 'local_search', query, mode: 'semantic', raw: '{}' },
      ctx,
      embed
    );
    if (!localSearchResultLooksEmpty(semanticBody)) body = semanticBody;
  }

  if (localSearchResultLooksEmpty(body)) {
    const keywords = query.split(/[\s,，、]+/).filter((k) => k.length >= 2);
    for (const kw of keywords) {
      if (kw === query) continue;
      const kwBody = await executeAgentLocalTool(
        { tool: 'local_search', query: kw, mode: 'filename', raw: '{}' },
        ctx,
        embed
      );
      if (!localSearchResultLooksEmpty(kwBody)) {
        body = kwBody;
        break;
      }
    }
  }

  if (localSearchResultLooksEmpty(body)) {
    const synonyms = expandTopicSynonyms(query).filter((s) => s !== query);
    for (const syn of synonyms) {
      const synBody = await executeAgentLocalTool(
        { tool: 'local_search', query: syn, mode: 'filename', raw: '{}' },
        ctx,
        embed
      );
      if (!localSearchResultLooksEmpty(synBody)) {
        body = `（按同义词「${syn}」匹配）\n${synBody}`;
        break;
      }
    }
  }

  let candidateDirs = '';
  if (localSearchResultLooksEmpty(body)) {
    const dirs = ['~/Documents', '~/Downloads', '~/Desktop'];
    const sections: string[] = [];
    for (const subpath of dirs) {
      const listText = await executeAgentLocalTool(
        { tool: 'local_list', subpath, maxDepth: 2, raw: '{}' },
        ctx,
        embed
      );
      if (
        !listText ||
        listText.startsWith('错误：') ||
        listText.startsWith('目录为空')
      ) {
        continue;
      }
      sections.push(`# ${subpath}\n${listText}`);
    }
    if (sections.length) candidateDirs = sections.join('\n\n').slice(0, 6000);
  }

  return {
    message: autoSearchSystemMessage(query, body, locale, candidateDirs),
    empty: localSearchResultLooksEmpty(body),
  };
}

async function runAutoImageSearch(
  userText: string,
  ctx: AgentLocalToolContext,
  locale: Locale
): Promise<{ message: Message; files: FileInfo[]; empty: boolean } | null> {
  if (!looksLikeLocalImageFindRequest(userText)) return null;
  const query = extractLocalSearchQuery(userText);
  if (!query) return null;
  const limit = parseMaxImageAttachCount(userText) ?? 3;
  const files = await findLocalImagesByKeyword(query, ctx, limit);
  const body =
    files.length > 0
      ? files.map((f) => `- ${f.name} (${f.path})`).join('\n')
      : '未找到匹配文件名的图片（.png/.jpg/.webp 等）。';
  const hint =
    files.length > 0
      ? locale === 'en'
        ? '\n\nImages above are already attached to the reply. Say ONE short sentence; do NOT generate images.'
        : '\n\n以上图片已自动贴到回复附件，请用一句话告知用户即可；禁止 AI 生图。'
      : locale === 'en'
        ? '\n\nNo local images found by filename. Tell the user briefly; do NOT generate images.'
        : '\n\n本机未找到匹配图片，请简要说明；禁止 AI 生图。';

  return {
    message: {
      id: `agent-auto-image-${Date.now()}`,
      role: 'system',
      content:
        (locale === 'en'
          ? `[System ran local_search image]\nQuery: ${query}\n${body}${hint}`
          : `【系统已自动执行本机图片检索】\n关键词：${query}\n${body}${hint}`) + '',
      timestamp: Date.now(),
      model: 'agent-auto-image',
    },
    files,
    empty: files.length === 0,
  };
}

export async function runAgentLoop(args: RunAgentLoopArgs): Promise<AgentLoopResult> {
  if (!useSettingStore.getState().agentBrowserEnabled) {
    /* browser off — fall through to local agent */
  } else if (userWantsWebPageDescription(args.userText)) {
    const url = extractUrlFromUserText(args.userText);
    if (!url) {
      const msg = buildWebBrowseMissingUrlMessage(args.locale);
      args.onReplyContent?.(msg);
      return { handled: true, displayText: msg };
    }
    const described = await executeWebPageDescribe(
      url,
      args.userText,
      args.model,
      args.locale,
      {
        onThinkingDelta: args.onThinkingDelta,
        onReplyContent: args.onReplyContent,
      }
    );
    if (described.ok) {
      args.onReplyContent?.(described.message);
      return {
        handled: true,
        displayText: described.message,
        reasoning: described.reasoning,
      };
    }
    args.onReplyContent?.(described.error);
    return { handled: true, displayText: described.error };
  }

  const webIntent = parseWebBrowseIntent(args.userText);
  if (webIntent && isSimpleWebBrowseOnly(args.userText, webIntent)) {
    if (!useSettingStore.getState().agentBrowserEnabled) {
      const msg =
        args.locale === 'en'
          ? 'Enable “In-chat browser” in Settings → Agent to open web pages inside the app.'
          : '请先在设置 → Agent 中开启「对话内嵌浏览」。';
      args.onReplyContent?.(msg);
      return { handled: true, displayText: msg };
    }
    const webOut = await executeWebBrowseIntent(webIntent, args.locale, args.userText);
    if (webOut.ok) {
      args.onReplyContent?.(webOut.message);
      return { handled: true, displayText: webOut.message };
    }
  }

  const workspaceRoot = useWorkspaceStore.getState().rootPath.trim();
  const deniedPaths = useSettingStore.getState().agentDeniedPaths;
  const toolCtx = { deniedPaths, workspaceRoot };
  const embed = useKnowledgeStore.getState().getEmbedConfigForIpc();
  const agentSystem: Message = {
    id: `agent-sys-${Date.now()}`,
    role: 'system',
    content: buildAgentCapabilitySystem(args.locale, workspaceRoot, '~'),
    timestamp: Date.now(),
    model: 'agent-capability',
  };

  let messages: Message[] = [
    agentSystem,
    buildUserTaskAnchor(args.userText, args.locale),
    ...buildAgentChainMessages(args.chainMessages, {
      id: `agent-user-${Date.now()}`,
      role: 'user',
      content: args.userText,
      timestamp: Date.now(),
      model: args.model.name,
    }),
  ];

  const executedTools = new Map<string, string>();
  let duplicateOnlyRounds = 0;
  let collectedExportFiles: FileInfo[] = [];
  let collectedAttachFiles: FileInfo[] = [];

  if (
    webIntent &&
    needsWebAgentWorkflow(args.userText) &&
    useSettingStore.getState().agentBrowserEnabled
  ) {
    const openUrl = resolveWebBrowseOpenUrl(webIntent, args.userText);
    const opened = await agentBrowserOpen(openUrl, { revealPanel: true });
    useAgentBrowserStore.getState().reveal();
    if (opened.ok) {
      const prefetchBody = `已在对话区下方打开：${opened.title || openUrl}\nURL：${openUrl}`;
      executedTools.set(
        toolCallSignature({ tool: 'web_open', url: openUrl, raw: '' }),
        prefetchBody
      );

      let imagePrefetchNote = '';
      if (userWantsWebFirstImage(args.userText)) {
        const extracted = await agentBrowserExtractFirstImage();
        if (extracted.ok) {
          const extractBody = `已提取第一张图片：${extracted.url}\n来源页：${extracted.pageUrl || openUrl}`;
          executedTools.set(BAIDU_FIRST_IMAGE_EXTRACT_SIG, extractBody);
          const baseName =
            webIntent.kind === 'baidu_search' ? webIntent.query : 'web-image';
          collectedAttachFiles.push({
            name: `${baseName}-1.jpg`,
            path: extracted.url,
            type: 'image/jpeg',
            size: 0,
            preview: extracted.url,
          });
          imagePrefetchNote =
            args.locale === 'en'
              ? `\n\n[System extracted the first image]\n${extracted.url}\nImage is attached to the reply. Tell the user briefly; do NOT claim no images were found.`
              : `\n\n【系统已自动提取第一张图片并加入附件】\n${extracted.url}\n请用一句话告知用户（图片在下方面板与附件中）；禁止再说「未找到图片」。`;
        } else {
          imagePrefetchNote =
            args.locale === 'en'
              ? `\n\n[System could not auto-extract an image: ${extracted.error}]`
              : `\n\n【系统未能自动提取图片】${extracted.error}`;
        }
      }

      messages = [
        ...messages,
        {
          id: `agent-web-prefetch-${Date.now()}`,
          role: 'system',
          content:
            (args.locale === 'en'
              ? `[System already web_opened — panel visible below; do NOT open the same URL again]\nURL: ${openUrl}\n\nUse web_read/web_eval only if still needed, then answer in plain language. Task: ${args.userText}`
              : `【系统已 web_open，下方面板已显示；禁止再次打开同一 URL】\n${openUrl}\n\n仅在必要时 web_read/web_eval，然后必须用自然语言完成：${args.userText}`) +
            imagePrefetchNote,
          timestamp: Date.now(),
          model: 'agent-web-prefetch',
        },
      ];
    }
  }
  let lastReasoning = '';
  let autoSearchDone = false;
  let autoSearchEmpty = false;
  let autoSearchQuery = '';
  let didReadSource = false;
  let webWrapNudged = false;

  if (looksLikeLocalImageFindRequest(args.userText) && !looksLikeWebBrowseRequest(args.userText)) {
    const imgPrefetch = await runAutoImageSearch(args.userText, toolCtx, args.locale);
    if (imgPrefetch) {
      messages = [...messages, imgPrefetch.message];
      collectedAttachFiles = imgPrefetch.files;
      autoSearchDone = true;
      autoSearchEmpty = imgPrefetch.empty;
      autoSearchQuery = extractLocalSearchQuery(args.userText);
    }
  } else if (!looksLikeWebBrowseRequest(args.userText)) {
    const prefetch = await runAutoSearch(args.userText, toolCtx, embed, args.locale);
    if (prefetch) {
      messages = [...messages, prefetch.message];
      autoSearchDone = true;
      autoSearchEmpty = prefetch.empty;
      autoSearchQuery = extractLocalSearchQuery(args.userText);
    }
  }

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    const response = await callModelAgentRound(messages, args.model, args.locale, {
      onThinkingDelta: args.onThinkingDelta,
      onDelta: args.onContentDelta,
    });
    const content = String(response.content ?? '').trim();
    const reasoningIn = response.reasoning?.trim() ?? '';
    if (reasoningIn) {
      lastReasoning = lastReasoning ? `${lastReasoning}\n\n${reasoningIn}` : reasoningIn;
    }

    const toolCalls = extractAgentLocalToolCalls(content);
    if (!toolCalls.length) {
      const isWebTask = looksLikeWebBrowseRequest(args.userText);
      const shouldRetryWithSearch =
        !isWebTask &&
        looksLikeLocalFileAgentRequest(args.userText) &&
        !looksLikeLocalImageFindRequest(args.userText) &&
        (modelDefersLocalFileWorkToUser(content, args.userText) || !autoSearchDone) &&
        round < MAX_AGENT_ROUNDS - 1;

      if (shouldRetryWithSearch) {
        const nextMessages: Message[] = [...messages];
        if (content) {
          nextMessages.push({
            id: `agent-asst-${Date.now()}-${round}`,
            role: 'assistant',
            content,
            ...(reasoningIn ? { reasoning: reasoningIn } : {}),
            timestamp: Date.now(),
            model: args.model.name,
          });
        }
        if (!autoSearchDone) {
          const autoMsg = await runAutoSearch(args.userText, toolCtx, embed, args.locale);
          if (autoMsg) {
            nextMessages.push(autoMsg.message);
            autoSearchDone = true;
            autoSearchEmpty = autoMsg.empty;
            autoSearchQuery = extractLocalSearchQuery(args.userText);
          }
        }
        nextMessages.push({
          id: `agent-nudge-${Date.now()}`,
          role: 'system',
          content:
            args.locale === 'en'
              ? 'Use the search results above. Do not ask the user for document names. Summarize or call local_read if needed.'
              : '请基于上方检索结果直接回答；若需读正文可输出 local_read JSON，勿再向用户索要文档名。',
          timestamp: Date.now(),
          model: 'agent-nudge',
        });
        messages = nextMessages;
        continue;
      }

      let displayText = stripAgentLocalToolArtifacts(content);
      const isExcerptTask = userRequestsExcerpt(args.userText);
      /** 摘录场景下用户要的就是原文片段，对回答是否复述主题词不再苛求；只要求曾经 local_read 过 */
      const drifted = !isExcerptTask && answerDriftsFromUserTopic(displayText, args.userText);
      const excerptWithoutRead = isExcerptTask && !didReadSource;
      /** 摘录已经读过原文，但回答夹带评价/建议/总结——越权点评，需纠正 */
      const excerptCommentary =
        isExcerptTask && didReadSource && answerLooksLikeCommentary(displayText);

      if ((drifted || excerptWithoutRead || excerptCommentary) && round < MAX_AGENT_ROUNDS - 1) {
        const nextMessages: Message[] = [...messages];
        if (content) {
          nextMessages.push({
            id: `agent-asst-drift-${Date.now()}-${round}`,
            role: 'assistant',
            content,
            ...(reasoningIn ? { reasoning: reasoningIn } : {}),
            timestamp: Date.now(),
            model: args.model.name,
          });
        }
        let nudgeContent: string;
        if (args.locale === 'en') {
          if (excerptCommentary) {
            nudgeContent =
              'STOP commentary. The user asked for ONE original sentence from the file. ' +
              'Output ONLY that raw sentence — no evaluation, no suggestion, no improvement, no summary, no preface, no quotes.';
          } else if (drifted) {
            nudgeContent =
              'Your answer drifted from the user topic. Ignore unrelated chat history. Use local_read on a matching file, then excerpt ≤30 chars from that file only.';
          } else {
            nudgeContent =
              'User asked for an excerpt but you have not called local_read yet. Output local_read JSON first.';
          }
        } else {
          if (excerptCommentary) {
            nudgeContent =
              '禁止评论。用户只要求"从文章里挑一句原文"，请只输出那一句原文，**不要**评价、建议、改进、总结、解释、加引号、加前缀。整条回答应是一句原文，不超过用户指定的字数。';
          } else if (drifted) {
            nudgeContent =
              '回答偏离用户主题（勿续写会话里无关内容如地役权）。请对检索命中的文件 local_read，再摘录不超过 30 字的原文。';
          } else {
            nudgeContent = '用户要求摘录，但你尚未 local_read 读文件。请先输出 local_read JSON 读取文件正文。';
          }
        }
        nextMessages.push({
          id: `agent-drift-nudge-${Date.now()}`,
          role: 'system',
          content: nudgeContent,
          timestamp: Date.now(),
          model: 'agent-drift-nudge',
        });
        messages = nextMessages;
        continue;
      }

      if (
        !isWebTask &&
        modelDefersLocalFileWorkToUser(content, args.userText) &&
        autoSearchDone &&
        autoSearchEmpty
      ) {
        displayText = buildEmptyLocalSearchFallbackDisplay(
          autoSearchQuery || extractLocalSearchQuery(args.userText),
          args.locale
        );
      } else if (drifted || excerptWithoutRead) {
        displayText = buildEmptyLocalSearchFallbackDisplay(
          autoSearchQuery || extractLocalSearchQuery(args.userText),
          args.locale
        );
      }
      if (displayText) args.onReplyContent?.(displayText);
      const allFiles = [...collectedExportFiles, ...collectedAttachFiles];
      return {
        handled: true,
        displayText: displayText || content,
        reasoning: lastReasoning || undefined,
        exportFiles: allFiles.length ? allFiles : undefined,
      };
    }

    const assistantMsg: Message = {
      id: `agent-asst-${Date.now()}-${round}`,
      role: 'assistant',
      content,
      ...(reasoningIn ? { reasoning: reasoningIn } : {}),
      timestamp: Date.now(),
      model: args.model.name,
    };
    messages = [...messages, assistantMsg];

    const { resultText, exportFiles, attachFiles, skippedDuplicate } =
      await runAgentLocalToolBatch(toolCalls, toolCtx, embed, executedTools);
    if (toolCalls.some((t) => t.tool === 'local_read' || t.tool === 'web_read')) {
      didReadSource = true;
    }
    collectedExportFiles = [...collectedExportFiles, ...exportFiles];
    collectedAttachFiles = [...collectedAttachFiles, ...attachFiles];
    messages = [...messages, toolResultMessage(toolCalls.map((t) => t.tool).join(','), resultText)];

    if (skippedDuplicate > 0 && skippedDuplicate === toolCalls.length) {
      duplicateOnlyRounds += 1;
      messages = [
        ...messages,
        {
          id: `agent-dup-nudge-${Date.now()}-${round}`,
          role: 'system',
          content:
            args.locale === 'en'
              ? 'You repeated identical tool calls; nothing new was executed. Answer the user in plain language now — no more tool JSON.'
              : '你重复调用了相同工具，未产生新结果。请立即用自然语言回答用户，禁止再输出工具 JSON。',
          timestamp: Date.now(),
          model: 'agent-dup-nudge',
        },
      ];
      if (duplicateOnlyRounds >= 2) {
        const displayText = buildAgentExhaustedDisplay(executedTools, args.locale);
        args.onReplyContent?.(displayText);
        const allFiles = [...collectedExportFiles, ...collectedAttachFiles];
        return {
          handled: true,
          displayText,
          reasoning: lastReasoning || undefined,
          exportFiles: allFiles.length ? allFiles : undefined,
        };
      }
      continue;
    }
    duplicateOnlyRounds = 0;

    if (didReadSource && needsWebAgentWorkflow(args.userText) && !webWrapNudged) {
      webWrapNudged = true;
      messages = [
        ...messages,
        {
          id: `agent-web-wrap-${Date.now()}`,
          role: 'system',
          content:
            args.locale === 'en'
              ? 'Page content is already in tool results above. Output your final answer to the user in plain language only (no tool JSON).'
              : '页面内容已在上方工具结果中。请仅用自然语言输出给用户的最终回答（不要工具 JSON）。',
          timestamp: Date.now(),
          model: 'agent-web-wrap',
        },
      ];
    }
  }

  const allFiles = [...collectedExportFiles, ...collectedAttachFiles];
  const displayText = buildAgentExhaustedDisplay(executedTools, args.locale);
  args.onReplyContent?.(displayText);
  return {
    handled: true,
    displayText,
    reasoning: lastReasoning || undefined,
    exportFiles: allFiles.length ? allFiles : undefined,
  };
}
