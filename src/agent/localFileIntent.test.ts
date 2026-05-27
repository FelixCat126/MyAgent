import { describe, expect, it } from 'vitest';
import {
  answerDriftsFromUserTopic,
  buildAgentChainMessages,
  extractLocalSearchQuery,
  localSearchResultLooksEmpty,
  looksLikeLocalFileAgentRequest,
  looksLikeLocalImageFindRequest,
  modelDefersLocalFileWorkToUser,
  parseMaxImageAttachCount,
} from './localFileIntent';
import type { Message } from '../types';

describe('localFileIntent', () => {
  it('识别本机找已有图片（非生图）', () => {
    const q = '在我本机找一下有没有手表的照片，有的话贴出来给我（最多3张）';
    expect(looksLikeLocalImageFindRequest(q)).toBe(true);
    expect(parseMaxImageAttachCount(q)).toBe(3);
    expect(extractLocalSearchQuery(q)).toContain('手表');
    expect(looksLikeLocalImageFindRequest('生成3张手表照片')).toBe(false);
    expect(looksLikeLocalImageFindRequest('画一张手表的图片')).toBe(false);
  });

  it('识别本机文件检索意图', () => {
    expect(looksLikeLocalFileAgentRequest('帮我在本机找合同相关的 docx')).toBe(true);
    expect(looksLikeLocalFileAgentRequest('今天天气怎么样')).toBe(false);
    expect(
      looksLikeLocalFileAgentRequest('打开百度，搜索"美女"，进入图片，然后把其中第一张图片返回给我')
    ).toBe(false);
  });

  it('网页找图不算本机找图', () => {
    const q = '打开百度，搜索"美女"，进入图片，然后把其中第一张图片返回给我';
    expect(looksLikeLocalImageFindRequest(q)).toBe(false);
  });

  it('提取搜索关键词', () => {
    expect(extractLocalSearchQuery('帮我在本机找合同相关的 docx')).toContain('合同');
    expect(extractLocalSearchQuery('在我本机找一篇描写机械表的文档，摘录里面不超过30字的一段话')).toBe(
      '机械表'
    );
    expect(
      extractLocalSearchQuery('从一篇写机械表的文章，摘录其中不超过30字的一句你认为写的比较好的话')
    ).toBe('机械表');
  });

  it('识别让用户提供文档名的推脱话术', () => {
    const reply = '请您提供文档或说明文档的名称，我才能为您查找并提取相关内容。';
    expect(modelDefersLocalFileWorkToUser(reply, '找一下民法典文档')).toBe(true);
  });

  it('识别「无法搜索 / 请将文档提供给我」类推脱', () => {
    const reply =
      '抱歉，我无法直接从您本地的文件系统中搜索到任何关于「机械表」的文档。请您将相关文档的内容提供给我，然后我可以帮您从中抽取最精彩的描述性语句。';
    expect(modelDefersLocalFileWorkToUser(reply, '从机械表文档里提取精彩描述')).toBe(true);
  });

  it('判断检索结果为空', () => {
    expect(localSearchResultLooksEmpty('未找到匹配文件名的文件。')).toBe(true);
    expect(localSearchResultLooksEmpty('- ~/Documents/a.md (a.md)')).toBe(false);
  });

  it('识别偏题回答（地役权 vs 机械表）', () => {
    const reply =
      '1. **地役权 (Servitude/Easement)**：在法律上，地役权是一种权利…简而言之，法律关系是载体，地役权是权利的具体化体现。';
    expect(
      answerDriftsFromUserTopic(reply, '在我本机找一篇描写机械表的文档，摘录里面不超过30字的一段话')
    ).toBe(true);
  });

  it('Agent 链只保留当前用户句', () => {
    const user: Message = {
      id: 'u1',
      role: 'user',
      content: '找机械表文档',
      timestamp: 1,
      model: 'm',
    };
    const chain: Message[] = [
      { id: 'a1', role: 'assistant', content: '地役权是…', timestamp: 0, model: 'm' },
      user,
    ];
    expect(buildAgentChainMessages(chain, user)).toEqual([user]);
  });
});
