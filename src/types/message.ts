import type { ModelConfig } from './model';

// 消息类型
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 模型的链式推理/思考文本（若有），与正文分离展示并可折叠 */
  reasoning?: string;
  /** 本轮用户明确要求生成可下载文档时，控制助手消息下方的下载入口 */
  exportHint?: {
    document?: boolean;
    formats?: Array<'md' | 'docx'>;
    status?: 'thinking' | 'generating';
  };
  /** 生图进行时供远端快照展示占位格；不写盘（见 chatStore.partialize） */
  imageGenProgress?: { current: number; total: number };
  /**
   * 消息元数据：与正文展示解耦。
   * kind=context-summary 表示自动/本地上下文压缩产生的摘要轮次。
   */
  meta?: {
    kind?: 'context-summary';
  };
  files?: FileInfo[];
  timestamp: number;
  model: string;
}

// 文件信息类型
export interface FileInfo {
  name: string;
  path: string;
  type: string;
  size: number;
  preview?: string;
}

export interface ImageGenerationParams {
  prompt: string;
  width?: number;
  height?: number;
  /** 期望生成张数；火山 Seedream 等多图接口会据此自动组 sequential 参数 */
  count?: number;
  /** 参考图：可为本地上传文件路径、远端 URL、data URL */
  referenceImages?: string[];
  modelId?: string;
  /** 必须由渲染进程传入：主进程无法读取 zustand 持久化（localStorage）里的模型列表 */
  imageGeneratorConfig?: ModelConfig['imageGeneratorConfig'];
  outputDir?: string;
  outputFormat?: string;
  modelPath?: string;
  modelFile?: string;
  /** 当前 prompt 是本轮用户输入的隔离生图任务，不应套用历史生图提示。 */
  isolatedPrompt?: boolean;
  /** 渲染进程内部用于逐张图片增量回传的请求标识。 */
  streamRequestId?: string;
}

export interface ToolCall {
  xid: string;
  type: string;
  args: Record<string, any> | null;
}