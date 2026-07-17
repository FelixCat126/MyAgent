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
}): AgentReplyGate {
  if (!isAgentToolsBuildEnabled() || opts.exportDocument) {
    return { enter: false, willRunLocalAgent: false, willRunWebAgent: false };
  }
  const { agentLocalToolsEnabled, agentBrowserEnabled } = useSettingStore.getState();
  const willRunLocalAgent =
    agentLocalToolsEnabled && looksLikeLocalFileAgentRequest(opts.userText);
  const willRunWebAgent =
    agentBrowserEnabled && looksLikeWebBrowseRequest(opts.userText);
  return {
    enter: willRunLocalAgent || willRunWebAgent,
    willRunLocalAgent,
    willRunWebAgent,
  };
}
