import { beforeEach, describe, expect, it } from 'vitest';
import { availableNativeTools, nativeCallToAgentCall, setMcpToolDescriptions } from './toolRegistry';
import { useSettingStore } from '../store/settingStore';
const call = (name: string, args: Record<string, unknown>) => nativeCallToAgentCall({ id: 'native-call', name, arguments: args });

beforeEach(() => {
  useSettingStore.setState({ agentLocalToolsEnabled: true, agentBrowserEnabled: true });
  setMcpToolDescriptions('create_record: write operation requiring approval');
});

describe('native tool calls honor their declared schema', () => {
  it('keeps valid native tools and explicit scope handling compatible with the JSON execution boundary', () => {
    expect(call('local_search', { query: '报告', mode: 'filename', limit: 3 })).toMatchObject({ tool: 'local_search', query: '报告', limit: 3 });
    expect(call('local_export', { format: 'xlsx', name: 'report', content: '真实正文' })).toMatchObject({ tool: 'local_export', format: 'xlsx' });
    expect(call('data_calculate', { path: '/project/report.csv', steps: [{ op: 'dedupe', columns: ['name'] }] })).toMatchObject({ tool: 'data_calculate', calculation: { path: '/project/report.csv' } });
    expect(call('web_close', {})).toMatchObject({ tool: 'web_close' });
  });

  it('rejects unknown tools and arguments, including model-supplied file authorization', () => {
    expect(() => call('unknown_tool', {})).toThrow();
    expect(() => call('local_read', { path: '/project/report.csv', unexpected: true })).toThrow('不接受参数');
    expect(() => call('local_read', { path: '/project/report.csv', toString: 'inherited property name' })).toThrow();
    expect(() => call('local_read', JSON.parse('{"path":"/project/report.csv","__proto__":{"scoped":false}}'))).toThrow();
    expect(() => call('data_calculate', { path: '/project/report.csv', steps: [], scope: { scoped: false } })).toThrow('不接受参数');
    expect(() => call('web_close', { url: 'https://example.com' })).toThrow('不接受参数');
  });

  it.each([
    ['local_read', { path: 1 }], ['local_search', { query: 'report', limit: 2.5 }],
    ['local_list', { extensions: 'csv' }], ['mcp_call', { connectionId: 'c', name: 'tool', args: [] }],
    ['data_calculate', { path: '/report.csv', steps: {} }], ['web_open', { url: null }],
  ] as const)('rejects invalid top-level argument types for %s', (name, args) => {
    expect(() => call(name, args)).toThrow();
  });

  it.each([
    ['local_read', {}], ['local_search', {}], ['web_open', {}], ['web_eval', {}],
    ['mcp_call', { connectionId: 'c', name: 'tool' }], ['data_calculate', { path: '/report.csv' }],
    ['local_export', { content: 'content', name: 'report' }], ['local_export', { format: 'md', content: 'content' }],
  ] as const)('rejects missing required arguments for %s', (name, args) => {
    expect(() => call(name, args)).toThrow();
  });

  it.each([
    ['non-string extension', 'local_list', { extensions: ['csv', 123] }],
    ['extensions above declared limit', 'local_list', { extensions: Array(31).fill('csv') }],
    ['non-object data step', 'data_calculate', { path: '/report.csv', steps: [123] }],
    ['missing nested chart fields', 'data_calculate', { path: '/report.csv', steps: [], chart: { type: 'bar' } }],
    ['unknown nested chart argument', 'data_calculate', { path: '/report.csv', steps: [], chart: { type: 'bar', x: 'name', y: 'value', injected: 'secret' } }],
  ] as const)('validates %s instead of silently stripping invalid data', (_label, name, args) => {
    expect(() => call(name, args)).toThrow();
  });

  it('rejects invalid enum values, limits and unsafe URLs before execution', () => {
    expect(() => call('local_search', { query: 'report', mode: 'unknown' })).toThrow();
    expect(() => call('local_search', { query: 'report', limit: 51 })).toThrow();
    expect(() => call('local_list', { maxDepth: 6 })).toThrow();
    expect(() => call('web_read', { maxChars: 99 })).toThrow();
    expect(() => call('web_open', { url: 'file:///private.csv' })).toThrow();
    expect(() => call('web_open', { url: 'https://user:password@example.com/' })).toThrow();
  });

  it('lists only capabilities currently enabled in settings', () => {
    useSettingStore.setState({ agentLocalToolsEnabled: false, agentBrowserEnabled: false });
    expect(availableNativeTools().map((entry) => entry.name)).toEqual(['mcp_call']);
    setMcpToolDescriptions('');
    expect(availableNativeTools()).toEqual([]);
  });
});
