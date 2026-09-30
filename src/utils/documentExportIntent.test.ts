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
    expect(documentArtifactBaseNameFromContent('# 示例数据表（可用于导出至 Excel）\n\n正文')).toBe('示例数据表');
  });
});

describe('explicit formats and intent boundaries', () => {
  it.each([
    ['把这个报告导出成 PDF', ['pdf']],
    ['生成 Excel 表格给我下载', ['xlsx']],
    ['整理成 Markdown 文档下载', ['md']],
    ['把刚才那个改成 PDF', ['pdf']],
    ['给我 Word 和 PDF 两个版本', ['docx', 'pdf']],
    ['导出 CSV 文件', ['csv']],
    ['保存为 TXT', ['txt']],
    ['把 Word 转成 PDF', ['pdf']],
    ['不要 PDF，给我 Word', ['docx']],
    ['帮我写一份 PDF 报告', ['pdf']],
    ['根据这份 PDF 生成 Word 文档', ['docx']],
  ])('%s', (input, expected) => expect(inferDocumentExportHint(input)?.formats).toEqual(expected));
  it.each(['不要生成文件，只解释 Word 文档的下载方法', '如何生成 PDF', '只讨论一下 Excel 排版', 'PDF 和 Word 有什么区别'])('does not execute discussion: %s', input => expect(inferDocumentExportHint(input)).toBeUndefined());
  it('does not discard PDF or spreadsheet formats downstream', () => expect(documentExportFormatsFromHint({ formats: ['pdf', 'xlsx', 'csv', 'txt', 'pdf'] })).toEqual(['pdf', 'xlsx', 'csv', 'txt']));
});
