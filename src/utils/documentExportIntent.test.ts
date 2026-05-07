import { describe, expect, it } from 'vitest';
import {
  documentArtifactBaseName,
  documentArtifactBaseNameFromContent,
  documentExportFormatsFromHint,
  inferDocumentExportHint,
  shouldBypassModelForFullTextDownload,
} from './documentExportIntent';

describe('documentExportIntent', () => {
  it('识别明确文档下载格式', () => {
    expect(inferDocumentExportHint('生成一份 word 格式的文档供我下载')?.formats).toEqual(['docx']);
    expect(inferDocumentExportHint('整理成 markdown 下载')?.formats).toEqual(['md']);
    expect(inferDocumentExportHint('生成电子版文档下载')?.formats).toEqual(['docx']);
  });

  it('普通问答不触发文档下载', () => {
    expect(inferDocumentExportHint('三国演义讲了什么')).toBeUndefined();
    expect(inferDocumentExportHint('帮我写一段回答')).toBeUndefined();
  });

  it('既有著作全文下载无源文本时绕过模型长篇打印', () => {
    expect(shouldBypassModelForFullTextDownload('三国演义全文文档下载')).toBe(true);
    expect(shouldBypassModelForFullTextDownload('提供下载的三国演义原著电子版')).toBe(true);
    expect(shouldBypassModelForFullTextDownload('给我节选一下西游记的前10回，生成一个文档供我下载')).toBe(true);
    expect(shouldBypassModelForFullTextDownload('把这本书全本文档下载', true)).toBe(false);
    expect(shouldBypassModelForFullTextDownload('原创写一篇小说全文，生成 word 下载')).toBe(false);
    expect(shouldBypassModelForFullTextDownload('生成一份三国演义人物分析报告 word 下载')).toBe(false);
  });

  it('产物格式与文件名稳定', () => {
    expect(documentExportFormatsFromHint(inferDocumentExportHint('生成一份 word 格式的文档供我下载'))).toEqual(['docx']);
    expect(documentArtifactBaseName('请生成《测试报告》word文档下载')).toBe('测试报告');
    expect(documentArtifactBaseName('请帮我生成一份很长很长的需求说明然后下载')).toBe('document');
    expect(documentArtifactBaseNameFromContent('# 年度经营分析报告\n\n正文')).toBe('年度经营分析报告');
  });
});
