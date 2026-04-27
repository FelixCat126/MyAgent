/** 联网搜索提供商（DuckDuckGo 无需 Key；Tavily / Brave 需 API Key） */
export type WebSearchProvider = 'duckduckgo' | 'tavily' | 'brave';

export interface WebSearchRequest {
  query: string;
  provider: WebSearchProvider;
  apiKey?: string;
}

export interface WebSearchResponse {
  ok: boolean;
  text: string;
  error?: string;
}

// Electron API 类型定义
export interface ElectronAPI {
  sendMessage: (channel: string, data: any) => void;
  /** 返回取消订阅函数，避免热重载或重复注册 */
  onMessage: (channel: string, func: (...args: any[]) => void) => () => void;
  callModel: (
    messages: Message[],
    config: ModelConfig,
    options?: { locale?: 'zh' | 'en' }
  ) => Promise<any>;
  /** OpenAI/兼容 与 Ollama：使用 subscribeModelStream 流式，须配合 closeModelStream 与事件监听 */
  subscribeModelStream: (
    messages: Message[],
    config: ModelConfig,
    handlers: {
      onDelta: (t: string) => void;
      onEnd: () => void;
      onError: (m: string) => void;
      locale?: 'zh' | 'en';
    }
  ) => () => void;
  closeModelStream: () => void;
  saveTextFile: (arg: {
    defaultName: string;
    content: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<{ ok: boolean; path?: string }>;
  importTextFile: () => Promise<{ ok: boolean; text?: string; name?: string }>;
  readTextFileAbsolute: (p: string) => Promise<{
    ok: boolean;
    text?: string;
    path?: string;
    error?: string;
  }>;
  readWorkspaceHint: (arg: { root: string; maxChars: number }) => Promise<{
    ok: boolean;
    fileName?: string;
    text?: string;
  }>;
  getClipboardText: () => Promise<string>;
  setClipboardText: (t: string) => Promise<boolean>;
  uploadFile: (fileData: any) => Promise<FileInfo & { preview?: string }>;
  launchApp: (appName: string) => Promise<boolean>;
  getInstalledApps: () => Promise<string[]>;
  generateImage: (params: ImageGenerationParams) => Promise<{ url: string; path: string; width: number; height: number }>;
  webSearch: (params: WebSearchRequest) => Promise<WebSearchResponse>;
  /** 渲染进程 zustand 持久化：写入 ~/Library/Application Support/MyAgent/persist/（与安装包共用） */
  persistGet: (name: string) => Promise<string | null>;
  persistSet: (name: string, value: string) => Promise<void>;
  persistRemove: (name: string) => Promise<void>;
  persistClearAll: () => Promise<void>;
  /** 小字段首屏用：引导是否已关 */
  persistGetSync: (name: string) => string | null;
  persistSetSync: (name: string, value: string) => void;
}

// 模型配置类型
export interface ModelConfig {
  id: string;
  name: string;
  provider: 'openai' | 'claude' | 'gemini' | 'ollama' | 'custom';
  apiUrl: string;
  apiKey?: string;
  modelName: string;
  isLocal: boolean;
  maxTokens: number;
  /** 是否允许作为图像生成工具调用的"生图模型"，用于 <GenerateImage> */
  isImageGenerator?: boolean;
  imageGeneratorConfig?: {
    type: 'cli' | 'http';
    /** CLI：可执行文件或脚本路径 */
    command?: string;
    /** HTTP：完整 URL（如 SD WebUI txt2img、Ollama /api/generate） */
    endpoint?: string;
    env?: Record<string, string>;
    /**
     * HTTP 响应解析：auto 自动识别；sdwebui = Automatic1111/Forge txt2img JSON；
     * ollama = Ollama /api/generate JSON；raw = 响应体即为图片二进制
     */
    httpFormat?: 'auto' | 'sdwebui' | 'ollama' | 'raw';
    /**
     * CLI 参数：每行一条，占位符 {{prompt}} {{outputPath}} {{width}} {{height}}
     * 留空则不给进程传 argv，仅用环境变量（推荐本地脚本读 MYAGENT_*）
     */
    cliArgLines?: string;
  };
}

// 消息类型
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
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
  modelId?: string;
  /** 必须由渲染进程传入：主进程无法读取 zustand 持久化（localStorage）里的模型列表 */
  imageGeneratorConfig?: ModelConfig['imageGeneratorConfig'];
  outputDir?: string;
  outputFormat?: string;
  modelPath?: string;
  modelFile?: string;
}

export interface ToolCall {
  xid: string;
  type: string;
  args: Record<string, any> | null;
}

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
}

// 全局 Window 接口扩展
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}