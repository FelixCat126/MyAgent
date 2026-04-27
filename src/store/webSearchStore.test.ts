import { beforeEach, describe, expect, it } from 'vitest';
import { useWebSearchStore } from './webSearchStore';

function reset() {
  localStorage.removeItem('web-search-storage');
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
});
