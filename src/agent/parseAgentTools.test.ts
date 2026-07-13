import { describe, expect, it } from 'vitest';
import {
  extractAgentLocalToolCalls,
  stripAgentLocalToolArtifacts,
  toolCallSignature,
} from './parseAgentTools';

describe('parseAgentTools', () => {
  it('解析 local_read 与 local_search JSON', () => {
    const text =
      '说明。\n{"myagent_tool":"local_search","query":"合同","mode":"semantic"}\n{"myagent_tool":"local_read","path":"docs/a.md"}';
    const calls = extractAgentLocalToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0].tool).toBe('local_search');
    if (calls[0].tool === 'local_search') {
      expect(calls[0].query).toBe('合同');
    }
    expect(calls[1].tool).toBe('local_read');
  });

  it('toolCallSignature 相同 web_open 去重', () => {
    const a = toolCallSignature({ tool: 'web_open', url: 'https://image.baidu.com/search/?word=x', raw: '' });
    const b = toolCallSignature({ tool: 'web_open', url: 'https://image.baidu.com/search?word=x', raw: '' });
    expect(a).toBe(b);
  });

  it('提图类 web_eval 归一为同一签名', () => {
    const a = toolCallSignature({
      tool: 'web_eval',
      js: 'document.querySelector("[data-imgurl]")',
      raw: '',
    });
    const b = toolCallSignature({
      tool: 'web_eval',
      js: 'for (const img of document.querySelectorAll(".imgitem img")) { if (img.naturalWidth>48) return img }',
      raw: '',
    });
    expect(a).toBe(b);
    expect(a).toBe('web_eval:baidu-first-image-extract');
  });

  it('stripAgentLocalToolArtifacts 去掉工具 JSON', () => {
    const raw =
      '已处理。\n{"myagent_tool":"local_export","format":"xlsx","content":"|a|b|\\n|-|-|\\n|1|2|","name":"汇总"}';
    const stripped = stripAgentLocalToolArtifacts(raw);
    expect(stripped).toBe('已处理。');
    expect(stripped).not.toContain('myagent_tool');
  });
});
