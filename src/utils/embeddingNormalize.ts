/**
 * 将用户在设置里粘贴的「对话接口」或其它误填格式，规整为可与 /v1/embeddings 拼接的根地址。
 * 期望形式示例：https://api.openai.com/v1 或 https://dashscope.aliyuncs.com/compatible-mode/v1
 */
export function normalizeEmbeddingOpenAiBaseUrl(raw: string): string {
  let u = String(raw || '').trim();
  if (!u) return u;
  try {
    u = u.replace(/\/+$/, '');
    // 常见误填：整段复制了 chat completions 路径
    const chop = [
      /\/v1\/chat\/completions$/i,
      /\/chat\/completions$/i,
      /\/v1\/completions$/i,
      /\/openai\/v1\/chat\/completions$/i,
    ];
    for (const re of chop) {
      if (re.test(u)) {
        u = u.replace(re, '');
        break;
      }
    }
    // 方舟：Coding 对话根 …/api/coding/v3 与官方文本向量化 …/api/v3 不同；嵌入勿用 coding 路径
    u = u.replace(/\/api\/coding\/v3$/i, '/api/v3');
    // 少数用户把 embeddings 整条路径贴进「根」
    u = u.replace(/\/v1\/embeddings$/i, '');
    u = u.replace(/\/+$/, '');
    return u;
  } catch {
    return raw.trim();
  }
}
