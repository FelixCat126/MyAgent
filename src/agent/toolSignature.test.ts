import { describe, expect, it } from 'vitest';
import { setToolPageKeyProvider, toolCallSignature } from './parseAgentTools';
import { nativeCallToAgentCall, validateAgentToolCall } from './toolRegistry';

describe('tool signatures and native parsing', () => {
  it('scopes web_read/web_eval signatures to the current page so a new page is read again', () => {
    let page = '1|https://a.example/';
    setToolPageKeyProvider(() => page);
    const read = toolCallSignature({ tool: 'web_read', raw: '' });
    const evalSig = toolCallSignature({ tool: 'web_eval', js: 'return document.title', raw: '' });
    page = '2|https://b.example/';
    expect(toolCallSignature({ tool: 'web_read', raw: '' })).not.toBe(read);
    expect(toolCallSignature({ tool: 'web_eval', js: 'return document.title', raw: '' })).not.toBe(evalSig);
    setToolPageKeyProvider(() => '');
  });

  it('accepts native arguments whose strings contain unbalanced braces', () => {
    const call = nativeCallToAgentCall({ id: '1', name: 'web_eval', arguments: { js: 'return "a{b";' } });
    expect(call).toMatchObject({ tool: 'web_eval', js: 'return "a{b";' });
  });

  it('accepts scheme-less web_open URLs like the browser normalizer does', () => {
    expect(() => validateAgentToolCall({ tool: 'web_open', url: 'www.baidu.com', raw: '{}' })).not.toThrow();
    expect(() => validateAgentToolCall({ tool: 'web_open', url: 'file:///etc/hosts', raw: '{}' })).toThrow();
  });
});
