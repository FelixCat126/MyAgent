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