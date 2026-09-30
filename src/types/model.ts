/** 对话接口协议偏好：auto 按 Endpoint/厂商推断；也可手动指定 */
export type ChatApiMode = 'auto' | 'openai' | 'anthropic';

// 模型配置类型
export interface ModelConfig {
  id: string;
  name: string;
  provider: 'openai' | 'claude' | 'gemini' | 'ollama' | 'custom';
  apiUrl: string;
  apiKey?: string;
  modelName: string;
  /**
   * 对话 API 协议。多数配置保持 auto 即可；双协议厂商可手动指定。
   * 缺省 / auto：完整 /messages 或 /chat/completions 路径优先；其后按 MiniMax、Anthropic URL、provider=claude 推断。
   */
  chatApiMode?: ChatApiMode;
  isLocal: boolean;
  /** 旧配置默认可用于对话；纯生图连接为 false。 */
  isChatModel?: boolean;
  contextWindowTokens?: number;
  maxTokens: number;
  /** 是否允许作为图像生成工具调用的"生图模型"，用于 <GenerateImage> */
  isImageGenerator?: boolean;
  imageGeneratorConfig?: {
    type: 'cli' | 'http';
    promptLanguage?: 'auto' | 'en';
    apiKeySource?: 'independent' | 'connection';
    quality?: 'auto' | 'low' | 'medium' | 'high';
    /**
     * 生图厂商标识，用于显式路由适配器（优先于 endpoint/模式推断）。
     * - bailian-wanx：阿里云百炼 DashScope 通义万相（wan2.6 同步）
     * - volc-seedream：火山方舟豆包 Seedream（OpenAI Images 兼容）
     * - openai-images：OpenAI Images 及其兼容网关
     * - sdwebui：AUTOMATIC1111/Forge txt2img
     * - ollama：Ollama /api/generate
     * - custom：自定义（走 raw/auto 兜底）
     * 留空时按 httpFormat + endpoint 自动推断（向后兼容老配置）。
     */
    provider?: 'bailian-wanx' | 'volc-seedream' | 'openai-images' | 'sdwebui' | 'ollama' | 'custom' | string;
    /** 结构化 API 密钥；优先于 env 中厂商对应 key，向后兼容老配置 */
    apiKey?: string;
    /** 结构化模型名；优先于 env 中厂商对应 key，向后兼容老配置 */
    model?: string;
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
  /** 是否允许作为视频生成工具调用的"视频模型" */
  isVideoGenerator?: boolean;
  videoGeneratorConfig?: {
    /**
     * 视频厂商标识：minimax（异步任务 + 轮询）；后续可扩展 runway/kling 等
     */
    provider: 'minimax' | 'custom' | string;
    /** API 密钥（视频厂商） */
    apiKey?: string;
    /** 模型名（如 MiniMax-Hailuo-02 / abab-video-1 / video-01） */
    model: string;
    /** 端点：MiniMax 视频任务国内 https://api.minimaxi.com  国际 https://api.minimax.io */
    endpoint?: string;
    /** 默认分辨率：720 / 768 / 1080；MiniMax 支持 5s/10s 默认 768x768 */
    resolution?: '480' | '720' | '768' | '1080';
    /** 时长（秒）：MiniMax 5 / 10 / 其它厂商各异 */
    duration?: 5 | 10;
  };
}
