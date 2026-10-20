import { expect as assert, it } from 'vitest';
import { shouldEnterAgentReply } from './shouldEnterAgentReply';
import { looksLikeLocalImageFindRequest } from './localFileIntent';
import { parseWebBrowseIntent, userWantsWebPageDescription, needsWebAgentWorkflow } from './webBrowseIntent';
import { getWebSearchQueryIfTriggered } from '../utils/webSearchTrigger';
import { inferDocumentExportHint, unsupportedDocumentRequest } from '../utils/documentExportIntent';
import { planImageIntent } from '../utils/imageIntentPlanner';
import { planAssistantVideoIntent } from '../chat/videoGenAssist';
import { useSettingStore } from '../store/settingStore';
import { setConnectedExternalToolNames } from './toolRegistry';

const cases: Array<[string, string, boolean?]> = [
  ['帮我在电脑上找一下关于合同的文档', 'local'],
  ['读一下 ~/Documents/report.docx', 'local'],
  ['总结一下我下载目录里的 pdf', 'local'],
  ['列出桌面上的文件', 'local'],
  ['find the contract files on my computer', 'local'],
  ['在本机找有没有手表的照片，最多3张', 'localImage'],
  ['怎么用 python 读取文件', 'chat'],
  ['总结一下上面这篇文章', 'chat'],
  ['打开百度搜索 机械表', 'web'],
  ['在百度搜索 猫 并返回第一张图片', 'web'],
  ['打开 https://github.com', 'web'],
  ['打开 github.com', 'web'],
  ['访问 https://example.com 看看', 'web'],
  ['https://example.com 这是什么网站', 'web'],
  ['帮我总结一下这个页面 https://example.com/post', 'web'],
  ['读一下这篇文章 https://example.com/a.html', 'web'],
  ['open https://example.com', 'web'],
  ['打开 readme.md', 'local'],
  ['今天北京天气怎么样', 'search'],
  ['最新的 AI 新闻', 'search'],
  ['搜索 react 19 新特性', 'search'],
  ['research paper on transformers', 'chat'],
  ['把上面的内容导出成 word', 'export'],
  ['生成一份 pdf 报告', 'export'],
  ['如何导出 pdf', 'chat'],
  ['做一个PPT', 'unsupported'],
  ['画一只猫', 'image'],
  ['生成三张赛博朋克风格的海报', 'image'],
  ['这张图片好看吗', 'chat'],
  ['帮我画个柱状图展示销售数据', 'chat'],
  ['在本机找猫的图片', 'localImage'],
  ['生成一段海边日落的视频', 'video'],
  ['做个 10 秒的短视频，内容是猫跳舞', 'video'],
  ['视频怎么剪辑', 'chat'],
  ['用 GitHub 工具查一下我的 issue', 'external'],
  ['调用 MCP 查询一下数据库', 'external'],
  ['按地区汇总销售额', 'data', true],
  ['画个流程图说明登录过程', 'chat'],
  ['帮我画一张思维导图', 'chat'],
  ['draw a cat in watercolor', 'image'],
  ['帮我画个城堡', 'image'],
  ['打开 report.pdf', 'local'],
  ["fetch('https://api.x.com') 报错怎么办", 'chat'],
  ['下载一份 word 版的周报', 'export'],
  ['visit github.com', 'web'],
  ['帮我翻译这个网页 https://example.com/en', 'web'],
];

it('routes representative requests to the intended feature', () => {
  useSettingStore.setState({ agentLocalToolsEnabled: true, agentBrowserEnabled: true });
  setConnectedExternalToolNames(['GitHub']);
  const rows: string[] = [];
  for (const [text, expect, data] of cases) {
    const gate = shouldEnterAgentReply({ userText: text, exportDocument: Boolean(inferDocumentExportHint(text)?.document), hasDataAttachments: data });
    const hits: string[] = [];
    if (gate.willRunLocalAgent) hits.push(data ? 'data' : 'local');
    if (looksLikeLocalImageFindRequest(text)) hits.push('localImage');
    if (gate.willRunWebAgent || parseWebBrowseIntent(text) || userWantsWebPageDescription(text) || needsWebAgentWorkflow(text)) hits.push('web');
    if (gate.enter && !gate.willRunLocalAgent && !gate.willRunWebAgent) hits.push('external');
    if (getWebSearchQueryIfTriggered(text)) hits.push('search');
    if (inferDocumentExportHint(text)?.document) hits.push('export');
    if (unsupportedDocumentRequest(text)) hits.push('unsupported');
    if (planImageIntent({ userText: text, historyBeforeUser: [] }).shouldGenerate) hits.push('image');
    if (planAssistantVideoIntent(text, '', false).shouldGenerate) hits.push('video');
    const ok = expect === 'chat' ? hits.length === 0 : hits.includes(expect);
    rows.push(`${ok ? 'OK  ' : 'MISS'} [${expect}] ${text} => ${hits.join(',') || '-'}${gate.enter ? ' (agent)' : ''}`);
  }
  assert(rows.filter(row => row.startsWith('MISS'))).toEqual([]);
});
