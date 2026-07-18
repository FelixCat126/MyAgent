import type { Message } from './message';

// 对话会话类型
export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** 非当前会话时收到助手新回复，左侧显示提醒；切回本会话后清除 */
  unreadAssistantReply?: boolean;
  /** 相对全局联网开关：本会话是否强制/关闭联网 */
  webSearchOverride?: 'default' | 'on' | 'off';
  /** Agent 本机工具：用户在本会话中显式指定的额外授权路径 */
  agentFileScope?: {
    extraRoots?: string[];
  };
  /** 应用内浏览：当前活跃 BrowserView 会话（Phase B） */
  activeBrowserSessionId?: string;
}