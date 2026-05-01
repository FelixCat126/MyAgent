import { describe, expect, it } from 'vitest';
import {
  extractGenerateImageCalls,
  extractLaunchAppNames,
  stripGenerateImageArtifactsForDisplay,
  stripRedundantAssistantImagePromptBlocks,
} from './toolCalls';

describe('extractLaunchAppNames', () => {
  it('解析 XML LaunchApp', () => {
    const t = '请执行 <LaunchApp name="访达" /> 结束';
    const r = extractLaunchAppNames(t);
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe('访达');
    expect(r[0].raw).toContain('LaunchApp');
  });

  it('解析 JSON myagent_tool launch_app', () => {
    const t = '{"myagent_tool":"launch_app","name":"终端"}';
    const r = extractLaunchAppNames(t);
    expect(r.some((x) => x.name === '终端')).toBe(true);
  });

  it('解析 tool launch_app 变体', () => {
    const t = '{"tool":"launch_app","name":"日历"}';
    const r = extractLaunchAppNames(t);
    expect(r.some((x) => x.name === '日历')).toBe(true);
  });
});

describe('extractGenerateImageCalls', () => {
  it('解析 XML GenerateImage 与可选宽高', () => {
    const t = '<GenerateImage prompt="一只猫" width="512" height="512" />';
    const r = extractGenerateImageCalls(t);
    expect(r).toHaveLength(1);
    expect(r[0].prompt).toBe('一只猫');
    expect(r[0].width).toBe(512);
    expect(r[0].height).toBe(512);
  });

  it('解析 JSON generate_image', () => {
    const t = '{"myagent_tool":"generate_image","prompt":"日落","width":768}';
    const r = extractGenerateImageCalls(t);
    expect(r).toHaveLength(1);
    expect(r[0].prompt).toBe('日落');
    expect(r[0].width).toBe(768);
  });

  it('解析行前空白的 JSON generate_image', () => {
    const t = '{  "myagent_tool":"generate_image","prompt":"云"}';
    expect(extractGenerateImageCalls(t)).toHaveLength(1);
  });

  it('解析 tool generate_image', () => {
    const t = '{ "tool":"generate_image","prompt":"海"}';
    expect(extractGenerateImageCalls(t)[0].prompt).toBe('海');
  });

  it('字段顺序无关：width 在 prompt 之前', () => {
    const t = '{"width":1024,"height":512,"myagent_tool":"generate_image","prompt":"序测试"}';
    const r = extractGenerateImageCalls(t);
    expect(r).toHaveLength(1);
    expect(r[0].prompt).toBe('序测试');
    expect(r[0].width).toBe(1024);
    expect(r[0].height).toBe(512);
  });
});

describe('stripRedundantAssistantImagePromptBlocks', () => {
  it('删掉模型「英文Prompt」围栏且正文一致，保留客户端可复制块', () => {
    const prompt =
      'Commercial e-commerce test, bikini, pool, compliant, Taobao-ready product hero image.';
    const raw =
      '说明。\n英文Prompt\n```text\n' +
      prompt +
      '\n```\n*[系统]*\n**本次生图使用的英文描述（可复制到其他平台）**\n```text\n' +
      prompt +
      '\n```\n';
    const cleaned = stripRedundantAssistantImagePromptBlocks(raw, [prompt]);
    expect(cleaned).not.toContain('英文Prompt');
    expect(cleaned).toContain('本次生图使用的英文描述');
    expect(cleaned).toContain('Commercial e-commerce');
  });

  it('不误删客户端「英文 Prompt（可复制）」小节', () => {
    const p = 'A red apple on wooden table';
    const raw = '前缀\n*[系统]*\n**英文 Prompt（可复制）**\n```text\n' + p + '\n```';
    expect(stripRedundantAssistantImagePromptBlocks(raw, [p])).toContain('英文 Prompt（可复制）');
  });
});

describe('stripGenerateImageArtifactsForDisplay', () => {
  it('移除含生图工具的 json 代码块', () => {
    const raw =
      '说明如下。\n\n```json\n{"myagent_tool":"generate_image","prompt":"测试"}\n```\n\n结束。';
    const s = stripGenerateImageArtifactsForDisplay(raw);
    expect(s).not.toContain('myagent_tool');
    expect(s).not.toContain('```');
    expect(s).toContain('说明');
    expect(s).toContain('结束');
  });

  it('移除单行裸漏生图 JSON（含 width/height）', () => {
    const line =
      '{"myagent_tool":"generate_image","prompt":"商品图","width":1024,"height":1536}';
    const s = stripGenerateImageArtifactsForDisplay(`前文\n${line}\n后文`);
    expect(s).not.toContain('myagent_tool');
    expect(s).not.toContain('1024');
    expect(s).toContain('前文');
    expect(s).toContain('后文');
  });

  it('流式未闭合 JSON：截掉尾部', () => {
    const s = stripGenerateImageArtifactsForDisplay('介绍文字\n{"myagent_tool":"generate_image"');
    expect(s).not.toContain('myagent_tool');
    expect(s).toContain('介绍文字');
  });

  it('去掉「到外站绘图平台粘贴 prompt」类复读', () => {
    const junk =
      '如果本地生图因密钥授权异常暂时失败，你可以复制上述prompt到文心一格、通义万相等第三方AI绘图平台，即可快速生成符合要求的图片。';
    const s = stripGenerateImageArtifactsForDisplay(`好的。\n${junk}\n说明完毕`);
    expect(s).not.toContain('文心一格');
    expect(s).not.toContain('通义');
    expect(s).toContain('好的');
    expect(s).toContain('说明完毕');
  });
});
