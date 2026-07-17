import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingStore } from '../store/settingStore';
import { shouldEnterAgentReply } from './shouldEnterAgentReply';

describe('shouldEnterAgentReply', () => {
  beforeEach(() => {
    useSettingStore.setState({
      agentLocalToolsEnabled: true,
      agentBrowserEnabled: true,
    });
  });

  it('本机工具开启但闲聊不进 Agent', () => {
    const g = shouldEnterAgentReply({ userText: '今天天气怎么样' });
    expect(g.enter).toBe(false);
    expect(g.willRunLocalAgent).toBe(false);
  });

  it('本机文件意图才进本机 Agent', () => {
    const g = shouldEnterAgentReply({ userText: '帮我在本机找合同相关的 docx' });
    expect(g.willRunLocalAgent).toBe(true);
    expect(g.enter).toBe(true);
  });

  it('文档导出不进 Agent', () => {
    const g = shouldEnterAgentReply({
      userText: '帮我在本机找合同',
      exportDocument: true,
    });
    expect(g.enter).toBe(false);
  });
});
