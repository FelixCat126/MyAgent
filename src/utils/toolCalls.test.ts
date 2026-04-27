import { describe, expect, it } from 'vitest';
import { extractGenerateImageCalls, extractLaunchAppNames } from './toolCalls';

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
});
