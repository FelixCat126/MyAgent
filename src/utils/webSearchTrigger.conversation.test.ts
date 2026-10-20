import { describe, expect, it } from 'vitest';
import { getWebSearchQueryIfTriggered } from './webSearchTrigger';

describe('webSearchTrigger conversational words', () => {
  it('does not search for references to the conversation or everyday plans', () => {
    expect(getWebSearchQueryIfTriggered('你刚才说的再解释一下')).toBeNull();
    expect(getWebSearchQueryIfTriggered('今天要写周报，帮我列个提纲')).toBeNull();
  });

  it('still searches for time-sensitive topics about today', () => {
    expect(getWebSearchQueryIfTriggered('北京今天的天气怎么样')).not.toBeNull();
    expect(getWebSearchQueryIfTriggered('今天有什么科技新闻')).not.toBeNull();
    expect(getWebSearchQueryIfTriggered('今天美元汇率多少')).not.toBeNull();
  });
});
