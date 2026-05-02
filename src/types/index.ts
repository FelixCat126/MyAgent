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

/** 工作区向量索引使用的嵌入服务（与对话模型独立配置） */
export type EmbeddingProviderKey = 'off' | 'openai' | 'ollama';

export interface KnowledgeEmbedConfig {
  provider: Exclude<EmbeddingProviderKey, 'off'>;
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** 火山 Doubao-embedding-vision：须走 /embeddings/multimodal；名称含 embedding-vision 且为方舟地址时自动为 true */
  volcMultimodal?: boolean;
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
      onThinkingDelta?: (t: string) => void;
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
  /** 将本机已有文件拷贝到用户选择的路径（保存为…） */
  saveLocalFileCopy: (arg: {
    sourcePath: string;
    defaultFileName: string;
  }) => Promise<{ ok: boolean; path?: string; error?: string }>;
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
  /** 返回 1 张或多张（如火山 sequential / 多 URL）；界面按顺序展示 */
  generateImage: (params: ImageGenerationParams) => Promise<
    Array<{ url: string; path: string; width: number; height: number }>
  >;
  webSearch: (params: WebSearchRequest) => Promise<WebSearchResponse>;
  /** 从本地已上传路径提取文档正文（xlsx / docx / md / txt 等） */
  extractDocumentText: (arg: { path: string; name?: string }) => Promise<{
    ok: boolean;
    text?: string;
    kind?: string;
    error?: string;
    /** 正文因上限被裁剪（仍可阅读部分） */
    truncated?: boolean;
  }>;
  /** 将助手消息全文导出为 md / xlsx(表格) / docx */
  saveAssistantExport: (arg: {
    format: 'md' | 'xlsx' | 'docx';
    content: string;
    defaultBaseName: string;
  }) => Promise<{ ok: boolean; path?: string }>;
  /** 为工作区构建向量索引（需先配置嵌入服务与模型） */
  knowledgeIndexWorkspace: (arg: {
    root: string;
    embed: KnowledgeEmbedConfig;
    mode?: 'full' | 'incremental';
  }) => Promise<{
    ok: boolean;
    fileCount?: number;
    chunkCount?: number;
    truncated?: boolean;
    root?: string;
    reusedChunks?: number;
    rebuiltFiles?: number;
    error?: string;
  }>;
  /** 按用户问题在索引中做向量检索，返回用于注入模型的文本 */
  knowledgeSearch: (arg: {
    root: string;
    query: string;
    topK: number;
    maxChars: number;
    embed: KnowledgeEmbedConfig;
  }) => Promise<{
    ok: boolean;
    text?: string;
    error?: string;
    meta?: { chunkCount: number; usedChunks: number };
  }>;
  knowledgeGetIndexStatus: () => Promise<{
    ok: boolean;
    chunkCount: number;
    root: string | null;
    model: string | null;
    updatedAt: number;
  }>;
  /** 渲染进程 zustand 持久化：写入 ~/Library/Application Support/MyAgent/persist/（与安装包共用） */
  persistGet: (name: string) => Promise<string | null>;
  persistSet: (name: string, value: string) => Promise<void>;
  persistRemove: (name: string) => Promise<void>;
  persistClearAll: () => Promise<void>;
  /** 小字段首屏用：引导是否已关 */
  persistGetSync: (name: string) => string | null;
  persistSetSync: (name: string, value: string) => void;
  /** 扫描生图目录、附件目录与会话中出现的图片路径合并去重（已删对话仍可保留磁盘文件） */
  listMediaLibraryImages: (payload?: {
    extraPaths?: string[];
  }) => Promise<{
    ok: boolean;
    items?: Array<{ absolutePath: string; mtimeMs: number }>;
    error?: string;
  }>;
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
     * ollama = Ollama /api/generate JSON；openai_images = POST /images/generations（OpenAI Images 兼容，含火山方舟/豆包远端）；
     * raw = 响应体即为图片二进制
      */
      httpFormat?: 'auto' | 'sdwebui' | 'ollama' | 'openai_images' | 'raw';
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
  /** 模型的链式推理/思考文本（若有），与正文分离展示并可折叠 */
  reasoning?: string;
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