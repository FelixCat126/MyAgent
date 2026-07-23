import { beforeEach, describe, expect, it } from 'vitest';
import { useWebSearchStore } from './webSearchStore';
import { PERSIST_KEYS } from '../utils/persistKeys';

function reset() {
  localStorage.removeItem(PERSIST_KEYS.webSearch);
  useWebSearchStore.setState({ enabled: true, provider: 'duckduckgo', apiKey: '' });
}

describe('webSearchStore', () => {
  beforeEach(() => {
    reset();
  });

  it('默认 duckduckgo 且联网开启', () => {
    const s = useWebSearchStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.provider).toBe('duckduckgo');
  });

  it('setEnabled / setProvider / setApiKey', () => {
    useWebSearchStore.getState().setEnabled(false);
    expect(useWebSearchStore.getState().enabled).toBe(false);
    useWebSearchStore.getState().setProvider('tavily');
    expect(useWebSearchStore.getState().provider).toBe('tavily');
    useWebSearchStore.getState().setApiKey('key');
    expect(useWebSearchStore.getState().apiKey).toBe('key');
  });

  it('persist migrate: searxng -> duckduckgo 并删除 searxngUrl', () => {
    const opts = useWebSearchStore.persist.getOptions();
    const migrate = opts.migrate;
    expect(migrate).toBeDefined();
    const raw = { provider: 'searxng', searxngUrl: 'http://x', enabled: true };
    const out = migrate!(raw as any, 1);
    expect((out as { provider: string }).provider).toBe('duckduckgo');
    expect((out as { searxngUrl?: string }).searxngUrl).toBeUndefined();
  });

  it('setEnabled 多次切换幂等', () => {
    useWebSearchStore.getState().setEnabled(false);
    useWebSearchStore.getState().setEnabled(false);
    expect(useWebSearchStore.getState().enabled).toBe(false);
    useWebSearchStore.getState().setEnabled(true);
    expect(useWebSearchStore.getState().enabled).toBe(true);
  });

  it('setApiKey 空字符串与长 key 都接受', () => {
    useWebSearchStore.getState().setApiKey('');
    expect(useWebSearchStore.getState().apiKey).toBe('');
    useWebSearchStore.getState().setApiKey('sk-tavily-1234567890');
    expect(useWebSearchStore.getState().apiKey).toBe('sk-tavily-1234567890');
  });

  it('setProvider 切换三个供应商', () => {
    useWebSearchStore.getState().setProvider('duckduckgo');
    expect(useWebSearchStore.getState().provider).toBe('duckduckgo');
    useWebSearchStore.getState().setProvider('tavily');
    expect(useWebSearchStore.getState().provider).toBe('tavily');
    useWebSearchStore.getState().setProvider('brave');
    expect(useWebSearchStore.getState().provider).toBe('brave');
  });

  it('persist merge: 远端 duckduckgo 字段无 apiKey 时不覆盖', () => {
    const opts = useWebSearchStore.persist.getOptions();
    const merge = opts.merge!;
    const persisted = { enabled: true, provider: 'duckduckgo' };
    const out = merge(persisted as never, {} as never) as { provider: string; enabled: boolean };
    expect(out.provider).toBe('duckduckgo');
    expect(out.enabled).toBe(true);
  });
});
