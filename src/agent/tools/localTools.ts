import type { FileInfo, KnowledgeEmbedConfig } from '../../types';
import { useSettingStore } from '../../store/settingStore';
import { expandTopicSynonyms, textMentionsTopicKeywords } from '../localFileIntent';
import type { AgentToolCall } from '../parseAgentTools';
import { toolCallSignature } from '../parseAgentTools';
import {
  agentBrowserClose,
  agentBrowserEval,
  agentBrowserOpen,
  agentBrowserRead,
} from '../browser/agentBrowserController';

export type AgentLocalToolContext = {
  deniedPaths: string[];
  workspaceRoot: string;
  shouldCancel?: () => boolean;
};

function assertLocalToolsEnabled(): string | null {
  if (!useSettingStore.getState().agentLocalToolsEnabled) {
    return '错误：未开启「本机文档 Agent」，无法执行本机文件工具。请在设置 → Agent 中开启。';
  }
  return null;
}

function assertBrowserEnabled(): string | null {
  if (!useSettingStore.getState().agentBrowserEnabled) {
    return '错误：未开启「对话内嵌浏览」，无法执行网页工具。请在设置 → Agent 中开启。';
  }
  return null;
}

function mimeFromImagePath(absPath: string): string {
  const ext = absPath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/png';
}

export function fileInfoFromLocalImagePath(
  absPath: string,
  size = 0,
  displayName?: string
): FileInfo {
  const name = displayName || absPath.split(/[\\/]/).pop() || 'image';
  return {
    name,
    path: absPath,
    type: mimeFromImagePath(absPath),
    size,
  };
}

export async function findLocalImagesByKeyword(
  pattern: string,
  ctx: AgentLocalToolContext,
  limit: number
): Promise<FileInfo[]> {
  const seen = new Set<string>();
  const out: FileInfo[] = [];
  const patterns = [...new Set([pattern, ...expandTopicSynonyms(pattern)])].filter(Boolean);

  for (const kw of patterns) {
    if (out.length >= limit) break;
    const r = await window.electron.agentLocalFindByName({
      deniedPaths: ctx.deniedPaths,
      pattern: kw,
      limit: limit - out.length,
      fileKind: 'image',
    });
    if (!r.ok || !r.matches?.length) continue;
    for (const m of r.matches) {
      if (out.length >= limit) break;
      if (seen.has(m.path)) continue;
      seen.add(m.path);
      out.push(fileInfoFromLocalImagePath(m.path, m.size ?? 0, m.name));
    }
  }
  return out;
}

export async function executeAgentLocalTool(
  call: AgentToolCall,
  ctx: AgentLocalToolContext,
  embed: KnowledgeEmbedConfig | null
): Promise<string> {
  const { deniedPaths, workspaceRoot } = ctx;

  if (call.tool.startsWith('local_')) {
    const denied = assertLocalToolsEnabled();
    if (denied) return denied;
  }
  if (call.tool.startsWith('web_')) {
    const denied = assertBrowserEnabled();
    if (denied) return denied;
  }

  switch (call.tool) {
    case 'local_search': {
      if (call.mode === 'image') {
        const limit = Math.max(1, Math.min(12, Number((call as { limit?: number }).limit) || 6));
        const files = await findLocalImagesByKeyword(call.query, ctx, limit);
        if (!files.length) return '未找到匹配文件名的图片（.png/.jpg/.webp 等）。';
        return (
          `找到 ${files.length} 张图片（已自动准备展示，请用一句话告知用户）：\n` +
          files.map((f) => `- ${f.name} → ${f.path}`).join('\n')
        );
      }
      if (call.mode === 'filename') {
        const r = await window.electron.agentLocalFindByName({
          deniedPaths,
          pattern: call.query,
          limit: 20,
        });
        if (!r.ok) return `错误：${r.error}`;
        if (!r.matches?.length) return '未找到匹配文件名的文件。';
        return r.matches
          .map((m) => `- ${(m as { displayPath?: string }).displayPath ?? m.rel} (${m.name})`)
          .join('\n');
      }
      if (workspaceRoot && embed) {
        const r = await window.electron.knowledgeSearch({
          root: workspaceRoot,
          query: call.query,
          topK: 8,
          maxChars: 12_000,
          embed,
        });
        if (r.ok && r.text?.trim()) {
          const meta = r.meta
            ? `\n（命中 ${r.meta.usedChunks ?? 0}/${r.meta.chunkCount ?? 0} 个分块）`
            : '';
          // 关键词二次过滤仅作提示，不再整段丢弃语义结果（避免同义词/表述差异误杀）
          const keywordNote = textMentionsTopicKeywords(r.text, call.query)
            ? ''
            : '\n（提示：语义命中正文未直接出现查询关键词，请结合上下文判断相关性）';
          return `${r.text}${meta}${keywordNote}`;
        }
      }
      const r = await window.electron.agentLocalFindByName({
        deniedPaths,
        pattern: call.query,
        limit: 15,
      });
      if (!r.ok) return `错误：${r.error}`;
      if (!r.matches?.length) {
        return workspaceRoot
          ? '向量检索未命中，且未找到匹配文件名的文件。'
          : '未找到相关文件（可按文件名再试，或配置工作区并建索引以启用语义检索）。';
      }
      return (
        (workspaceRoot ? '（语义未命中，以下为全机文件名匹配）\n' : '（全机文件名匹配）\n') +
        r.matches
          .map((m) => `- ${(m as { displayPath?: string }).displayPath ?? m.rel}`)
          .join('\n')
      );
    }

    case 'local_list': {
      const r = await window.electron.agentLocalList({
        deniedPaths,
        subpath: call.subpath,
        maxDepth: call.maxDepth,
        extensions: call.extensions,
      });
      if (!r.ok) return `错误：${r.error}`;
      if (!r.entries?.length) return '目录为空或无可索引文件。';
      const listBase = (r as { listBase?: string }).listBase;
      const header = listBase
        ? `目录根：${listBase}\nlocal_read 的 path 请使用下列完整路径（含 ~/Documents/ 等前缀）\n`
        : 'local_read 的 path 请使用下列完整路径\n';
      return (
        header +
        r.entries
          .map((e) => {
            const p = (e as { displayPath?: string }).displayPath ?? e.path ?? e.rel;
            return e.kind === 'dir' ? `[DIR] ${p}/` : `[FILE] ${p}${e.size != null ? ` (${e.size} B)` : ''}`;
          })
          .join('\n')
      );
    }

    case 'local_read': {
      const r = await window.electron.agentLocalRead({
        deniedPaths,
        path: call.path,
      });
      if (!r.ok) return `错误：${r.error}`;
      const head = `文件：${r.rel ?? call.path}${r.truncated ? '（正文已截断）' : ''}\n\n`;
      return head + (r.text ?? '');
    }

    case 'local_export': {
      const r = await window.electron.createDocumentArtifact({
        format: call.format,
        content: call.content,
        defaultBaseName: call.name,
      });
      if (!r.ok || !r.file) return `错误：${r.error ?? '导出失败'}`;
      return `已生成附件：${r.file.name}（${r.file.path}）`;
    }

    case 'web_open': {
      const r = await agentBrowserOpen(call.url, { shouldCancel: ctx.shouldCancel });
      if (!r.ok) return `错误：${r.error}`;
      return `已在对话区下方打开：${r.title || r.url}\nURL：${r.url}`;
    }

    case 'web_read': {
      const r = await agentBrowserRead({
        maxChars: call.maxChars,
        selector: call.selector,
        shouldCancel: ctx.shouldCancel,
      });
      if (!r.ok) return `错误：${r.error}`;
      const head = call.selector
        ? `选择器：${call.selector}（命中：${r.matched ? '是' : '否'}）\nURL：${r.url}\n标题：${r.title}\n\n`
        : `URL：${r.url}\n标题：${r.title}\n\n`;
      return head + (r.text ?? '');
    }

    case 'web_eval': {
      const r = await agentBrowserEval({ js: call.js, shouldCancel: ctx.shouldCancel });
      if (!r.ok) return `错误：${r.error}`;
      const resStr =
        typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null);
      return `执行结果：${resStr}`;
    }

    case 'web_close': {
      const r = await agentBrowserClose();
      return r.closed ? '已关闭内嵌浏览面板。' : '当前未打开内嵌浏览面板。';
    }

    default:
      return '错误：未知工具';
  }
}

/** 执行工具并返回给模型的文本结果；executed 用于跨轮次去重 */
export async function runAgentLocalToolBatch(
  calls: AgentToolCall[],
  ctx: AgentLocalToolContext,
  embed: KnowledgeEmbedConfig | null,
  executed?: Map<string, string>,
  opts?: { shouldCancel?: () => boolean }
): Promise<{ resultText: string; exportFiles: FileInfo[]; attachFiles: FileInfo[]; skippedDuplicate: number }> {
  const parts: string[] = [];
  const exportFiles: FileInfo[] = [];
  const attachFiles: FileInfo[] = [];
  let skippedDuplicate = 0;

  for (const call of calls) {
    if (opts?.shouldCancel?.()) {
      parts.push('【已取消】用户停止了本次操作。');
      break;
    }
    const sig = toolCallSignature(call);
    const cached = executed?.get(sig);
    if (cached !== undefined) {
      skippedDuplicate += 1;
      parts.push(
        `【${call.tool} 重复调用，已跳过】\n${cached.slice(0, 1800)}\n\n` +
          '（该步骤已完成，请勿再次输出相同 JSON；请根据以上结果用自然语言回答用户。）'
      );
      continue;
    }

    if (call.tool.startsWith('local_')) {
      const denied = assertLocalToolsEnabled();
      if (denied) {
        executed?.set(sig, denied);
        parts.push(`【${call.tool}】${denied}`);
        continue;
      }
    }
    if (call.tool.startsWith('web_')) {
      const denied = assertBrowserEnabled();
      if (denied) {
        executed?.set(sig, denied);
        parts.push(`【${call.tool}】${denied}`);
        continue;
      }
    }

    if (call.tool === 'local_export') {
      const r = await window.electron.createDocumentArtifact({
        format: call.format,
        content: call.content,
        defaultBaseName: call.name,
      });
      if (r.ok && r.file) {
        exportFiles.push(r.file);
        const msg = `已生成附件：${r.file.name}`;
        executed?.set(sig, msg);
        parts.push(`【${call.tool}】${msg}`);
      } else {
        const msg = `错误：${r.error ?? '导出失败'}`;
        executed?.set(sig, msg);
        parts.push(`【${call.tool}】${msg}`);
      }
      continue;
    }
    if (call.tool === 'local_search' && call.mode === 'image') {
      const limit = Math.max(1, Math.min(12, call.limit ?? 6));
      const files = await findLocalImagesByKeyword(call.query, ctx, limit);
      attachFiles.push(...files);
      const out = await executeAgentLocalTool(call, ctx, embed);
      executed?.set(sig, out);
      parts.push(`【${call.tool}】\n${out}`);
      continue;
    }
    const out = await executeAgentLocalTool(call, ctx, embed);
    executed?.set(sig, out);
    parts.push(`【${call.tool}】\n${out}`);
  }

  return {
    resultText:
      parts.join('\n\n').length > 24_000
        ? parts.join('\n\n').slice(0, 24_000) + '\n\n（工具结果已截断，以上为前部内容）'
        : parts.join('\n\n'),
    exportFiles,
    attachFiles,
    skippedDuplicate,
  };
}
