import { describe, expect, it } from 'vitest';
import { useSettingStore } from './settingStore';

describe('settingStore migrate defaults', () => {
  const migrate = useSettingStore.persist.getOptions().migrate!;

  it('keeps the embedded browser on, like fresh installs, when an old save lacks the field', () => {
    expect(useSettingStore.getInitialState().agentBrowserEnabled).toBe(true);
    expect((migrate({ locale: 'zh' } as never, 12) as { agentBrowserEnabled: boolean }).agentBrowserEnabled).toBe(true);
    expect((migrate({ agentBrowserEnabled: false } as never, 12) as { agentBrowserEnabled: boolean }).agentBrowserEnabled).toBe(false);
  });

  it('tolerates a save without state', () => {
    expect(() => migrate(undefined as never, 1)).not.toThrow();
  });
});
