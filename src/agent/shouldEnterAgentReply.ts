import { isAgentToolsBuildEnabled } from './buildFlags';
import { looksLikeLocalFileAgentRequest } from './localFileIntent';
import { looksLikeWebBrowseRequest } from './webBrowseIntent';
import { useSettingStore } from '../store/settingStore';

export type AgentReplyGate = {
  /** 是否进入 Agent 回复路径 */
  enter: boolean;
  willRunLocalAgent: boolean;
  willRunWebAgent: boolean;
};

/**
 * 桌面/远端共用：是否走 Agent，以及是否应跳过向量注入。
 * 本机工具开启本身不够，还需命中本机文件意图；浏览器同理需命中浏览意图。
 */
export function shouldEnterAgentReply(opts: {
  userText: string;
  /** 文档导出任务不进 Agent */
  exportDocument?: boolean;
  hasDataAttachments?: boolean;
}): AgentReplyGate {
  const dataTask=opts.hasDataAttachments && /分析|计算|汇总|去重|筛选|统计|同比|环比|chart|calculat|analys|group|sum|filter|dedup/i.test(opts.userText);
  const externalTask=/\bMCP\b|外部工具|外部服务|connected tool/i.test(opts.userText);
  if (!isAgentToolsBuildEnabled() || (opts.exportDocument && !dataTask)) {
    return { enter: false, willRunLocalAgent: false, willRunWebAgent: false };
  }
  const { agentLocalToolsEnabled, agentBrowserEnabled } = useSettingStore.getState();
  const willRunLocalAgent =
    agentLocalToolsEnabled && (looksLikeLocalFileAgentRequest(opts.userText)||Boolean(dataTask));
  const willRunWebAgent =
    agentBrowserEnabled && looksLikeWebBrowseRequest(opts.userText);
  return {
    enter: willRunLocalAgent || willRunWebAgent || externalTask,
    willRunLocalAgent,
    willRunWebAgent,
  };
}
