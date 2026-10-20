import { beforeEach, describe, expect, it } from 'vitest';
import { useWebSearchStore } from './webSearchStore';

beforeEach(() => {
  useWebSearchStore.setState({ enabled: true, provider: 'duckduckgo', apiKey: '', keys: { tavily: { apiKey: '' }, brave: { apiKey: '' } } });
});

describe('webSearchStore per-provider keys', () => {
  it('keeps Tavily and Brave keys separate when switching providers', () => {
    const s = useWebSearchStore.getState();
    s.setProvider('tavily'); s.setApiKey('tvly-1');
    s.setProvider('brave');
    expect(useWebSearchStore.getState().apiKey).toBe('');
    useWebSearchStore.getState().setApiKey('BSA-2');
    useWebSearchStore.getState().setProvider('tavily');
    expect(useWebSearchStore.getState().apiKey).toBe('tvly-1');
    useWebSearchStore.getState().setProvider('duckduckgo');
    expect(useWebSearchStore.getState()).toMatchObject({ apiKey: '', keys: { tavily: { apiKey: 'tvly-1' }, brave: { apiKey: 'BSA-2' } } });
  });

  it.each([0, 1])('migrates the shared v%s key into the selected provider slot', (version) => {
    const migrate = useWebSearchStore.persist.getOptions().migrate!;
    expect(migrate({ provider: 'brave', apiKey: 'BSA-old', enabled: true } as never, version)).toMatchObject({ apiKey: 'BSA-old', keys: { tavily: { apiKey: '' }, brave: { apiKey: 'BSA-old' } } });
    expect(migrate({ provider: 'duckduckgo', apiKey: 'shared' } as never, version)).toMatchObject({ apiKey: '', keys: { tavily: { apiKey: 'shared' }, brave: { apiKey: 'shared' } } });
    expect(migrate({ provider: 'searxng' } as never, version)).toMatchObject({ provider: 'duckduckgo', keys: { tavily: { apiKey: '' }, brave: { apiKey: '' } } });
  });

  it('stores keys under a field name that persist encryption recognizes', async () => {
    const { protectPersistValue } = await import('../../electron/utils/secureFields');
    const out = protectPersistValue({ state: { keys: { tavily: { apiKey: 'tvly-1' } } } }, (plain) => `x${plain}`) as { state: { keys: { tavily: { apiKey: string } } } };
    expect(out.state.keys.tavily.apiKey).toBe('enc:v1:xtvly-1');
  });
});
