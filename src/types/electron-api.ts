import type { Message } from './message';
import type { FileInfo, ImageGenerationParams } from './message';
import type { ModelConfig } from './model';
import type { WebSearchRequest, WebSearchResponse } from './web-search';
import type { KnowledgeEmbedConfig } from './knowledge';

// Electron API 类型定义
export interface ElectronAPI {
  sendMessage: (channel: string, data: any) => void;
  /** 返回取消订阅函数，避免热重载或重复注册 */
  onMessage: (channel: string, func: (...args: any[]) => void) => () => void;
  callModel: (
    messages: Message[],
    config: ModelConfig,
    options?: { locale?: 'zh' | 'en'; temperature?: number }
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
      temperature?: number;
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
  }) => Promise<{
    ok: boolean;
    path?: string;
    error?: string;
    /** 用户在「另存为」中选取消；非失败 */
    canceled?: boolean;
  }>;
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
  generateImage: (
    params: ImageGenerationParams,
    handlers?: {
      onImage?: (p: {
        requestId: string;
        image: { url: string; path: string; width: number; height: number };
        index: number;
        total: number;
      }) => void;
    }
  ) => Promise<
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
  /** 后台生成一个文档产物并返回本地附件信息，不弹保存框 */
  createDocumentArtifact: (arg: {
    format: 'md' | 'docx' | 'xlsx';
    content: string;
    defaultBaseName: string;
  }) => Promise<{ ok: boolean; file?: FileInfo; error?: string }>;
  agentLocalList: (arg: {
    deniedPaths?: string[];
    subpath?: string;
    maxDepth?: number;
    extensions?: string[];
  }) => Promise<{
    ok: boolean;
    error?: string;
    entries?: { path: string; rel: string; kind: 'file' | 'dir'; size?: number }[];
  }>;
  agentLocalFindByName: (arg: {
    deniedPaths?: string[];
    pattern: string;
    limit?: number;
    extensions?: string[];
    fileKind?: 'document' | 'image';
  }) => Promise<{
    ok: boolean;
    error?: string;
    matches?: { path: string; rel: string; name: string; displayPath?: string; size?: number }[];
  }>;
  agentLocalRead: (arg: {
    deniedPaths?: string[];
    path: string;
    maxChars?: number;
  }) => Promise<{
    ok: boolean;
    error?: string;
    path?: string;
    rel?: string;
    text?: string;
    kind?: string;
    truncated?: boolean;
  }>;
  /** Agent 浏览器：打开 / 复用单实例独立窗口并导航 */
  agentWebOpen: (arg: { url: string }) => Promise<{
    ok: boolean;
    url?: string;
    title?: string;
    error?: string;
  }>;
  /** 抓取当前页 url / title / 可见文本快照；selector 可选 */
  agentWebRead: (arg?: { maxChars?: number; selector?: string }) => Promise<{
    ok: boolean;
    url?: string;
    title?: string;
    text?: string;
    matched?: boolean;
    error?: string;
  }>;
  /** 在页面 context 执行 async JS，返回值需可 JSON 序列化（否则降级为 String） */
  agentWebEval: (arg: { js: string }) => Promise<{
    ok: boolean;
    result?: unknown;
    error?: string;
  }>;
  agentWebClose: () => Promise<{ ok: boolean; closed?: boolean; error?: string }>;
  /** 将远程网页图片落盘为本机附件（可选 referer / 页内 base64） */
  agentWebSaveRemoteImage: (arg: {
    url?: string;
    referer?: string;
    fileName?: string;
    base64?: string;
    contentType?: string;
  }) => Promise<{
    ok: boolean;
    path?: string;
    name?: string;
    type?: string;
    size?: number;
    preview?: string;
    error?: string;
  }>;
  /** 为工作区构建向量索引（需先配置嵌入服务与模型）；省略 mode 或与 incremental 等效时：能复用指纹则仅处理变更/新文件，否则内部全文重建；mode: 'full' 强制全文 */
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
  deleteMediaLibraryImage: (payload: { absolutePath: string }) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  transcribeAudio: (arg: {
    audio: number[];
    mimeType?: string;
    apiUrl: string;
    apiKey: string;
    provider: 'openai' | 'claude' | 'gemini' | 'ollama' | 'custom';
    whisperModel?: string;
    language?: string;
  }) => Promise<{ ok: true; text: string } | { ok: false; error?: string }>;
  volcAsrStart: (arg: {
    appKey: string;
    accessKey: string;
    resourceId: string;
    wakeMode?: boolean;
    hotwords?: string[];
  }) => Promise<{ ok: true } | { ok: false; error?: string }>;
  volcAsrPushChunk: (pcmInt16AsNumbers: number[]) => Promise<{ ok: boolean }>;
  volcAsrFinish: () => Promise<{ ok: boolean }>;
  volcAsrAbort: () => Promise<{ ok: boolean }>;
  remoteGatewayGetConfig: () => Promise<{ enabled: boolean; port: number; token: string }>;
  remoteGatewaySetConfig: (
    patch: Partial<{ enabled: boolean; port: number; token: string; regenerateToken: boolean }>
  ) => Promise<{ enabled: boolean; port: number; token: string }>;
  /** 一次性返回手势识别模型字节流；MediaPipe 直接用 modelAssetBuffer 加载，避免 fetch 自定义协议 */
  getGestureModelData: () => Promise<
    { ok: true; data: Uint8Array; path: string } | { ok: false; error?: string }
  >;
  /** 一次性返回面部 / 眼动模型字节流；MediaPipe FaceLandmarker 用 modelAssetBuffer 加载 */
  getFaceModelData: () => Promise<
    { ok: true; data: Uint8Array; path: string } | { ok: false; error?: string }
  >;
  /** 在视口坐标 (x,y) 处模拟指针移动，触发 :hover / mouseenter 等 */
  simulateGazeMove: (x: number, y: number) => Promise<{ ok: true } | { ok: false; error?: string }>;
  /** 在视口坐标 (x,y) 处模拟左键点击，供视线单眨触发 */
  simulateGazeClick: (x: number, y: number) => Promise<{ ok: true } | { ok: false; error?: string }>;
  simulateGazeWheel: (
    x: number,
    y: number,
    deltaY: number,
  ) => Promise<{ ok: true } | { ok: false; error?: string }>;
  /** 抓取主窗口视区 → PNG → 写入系统剪贴板，由双手前推手势触发 */
  capturePageToClipboard: () => Promise<
    { ok: true; width: number; height: number } | { ok: false; error?: string }
  >;
  /** 主窗口获得/失去焦点（Electron 主进程推送，弥补首次 show 时 hasFocus 不准） */
  onWindowFocusChanged?: (handler: (focused: boolean) => void) => () => void;
}

// 全局 Window 接口扩展
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}