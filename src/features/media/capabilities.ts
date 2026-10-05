import type { ModelConfig } from '../../types/model';
export type ImageCapabilities = { editing: boolean; mask: boolean; maxReferences: number; sizes: { width: number; height: number; label: string }[]; reason?: string };
export function imageCapabilities(config?: ModelConfig['imageGeneratorConfig']): ImageCapabilities {
  const provider = config?.provider && !['custom', 'auto'].includes(config.provider) ? config.provider : (/sdapi\/v1/i.test(config?.endpoint ?? '') ? 'sdwebui' : /volces/i.test(config?.endpoint ?? '') ? 'volc-seedream' : /images\/(generations|edits)/i.test(config?.endpoint ?? '') ? 'openai-images' : 'custom');
  const model = config?.model || config?.env?.REMOTE_IMAGE_MODEL || config?.env?.IMAGE_MODEL || '';
  const editing = config?.type === 'http' && (provider === 'sdwebui' || provider === 'volc-seedream' || (provider === 'openai-images' && /^(gpt-image-|chatgpt-image-)/i.test(model)));
  const mask = editing && (provider === 'sdwebui' || provider === 'openai-images');
  let sizes = provider === 'sdwebui' ? [[512, 512], [768, 768], [1024, 1024], [768, 1024], [1024, 768]] : provider === 'openai-images' && /gpt-image-/i.test(model) ? [[1024, 1024], [1536, 1024], [1024, 1536]] : provider === 'openai-images' && /dall-e-3/i.test(model) ? [[1024, 1024], [1792, 1024], [1024, 1792]] : [[1024, 1024], [1536, 1024], [1024, 1536]];
  if (config?.dimensions?.length) { const configured = config.dimensions.filter((s) => Number.isInteger(s.width) && Number.isInteger(s.height) && s.width > 0 && s.height > 0 && s.width <= 8192 && s.height <= 8192).map((s) => [s.width, s.height]); if (configured.length) sizes = configured.filter((s, i) => configured.findIndex((other) => other[0] === s[0] && other[1] === s[1]) === i); }
  return { editing, mask, maxReferences: provider === 'sdwebui' ? 1 : provider === 'volc-seedream' ? 14 : editing ? 16 : 0, sizes: sizes.map(([width, height]) => ({ width, height, label: `${width} × ${height}` })), reason: editing ? undefined : '当前服务未接入图片编辑，参考图不会被静默忽略。 / Image editing is not integrated for this provider.' };
}
