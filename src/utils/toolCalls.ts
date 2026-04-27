/**
 * 同时支持旧版 XML 标签与 JSON 工具声明（MCP/Agent 习惯）
 * JSON 示例：{"myagent_tool":"launch_app","name":"访达"} 或 {"tool":"generate_image","prompt":"..."}
 */
export function extractLaunchAppNames(text: string): { name: string; raw: string }[] {
  const out: { name: string; raw: string }[] = [];
  const reXml = /<LaunchApp\s+name="([^"]+)"\s*\/>/g;
  for (const m of text.matchAll(reXml)) {
    out.push({ name: m[1], raw: m[0] });
  }
  for (const m of text.matchAll(/\{"myagent_tool"\s*:\s*"launch_app"[^}]*"name"\s*:\s*"([^"\\]+)"[^}]*\}/gi)) {
    const raw = m[0];
    if (out.some((o) => o.raw === raw)) continue;
    out.push({ name: m[1], raw });
  }
  for (const m of text.matchAll(
    /\{"tool"\s*:\s*"(?:launchApp|launch_app)"[^}]*"name"\s*:\s*"([^"\\]+)"[^}]*\}/gi
  )) {
    const raw = m[0];
    if (out.some((o) => o.raw === raw)) continue;
    out.push({ name: m[1], raw });
  }
  return out;
}

export function extractGenerateImageCalls(
  text: string
): { prompt: string; width?: number; height?: number; raw: string }[] {
  const out: { prompt: string; width?: number; height?: number; raw: string }[] = [];
  const reXml =
    /<GenerateImage\s+prompt="([^"]+)"(?:\s+width="(\d+)"(?:\s+height="(\d+)"?)?)?\s*\/>/g;
  for (const m of text.matchAll(reXml)) {
    out.push({
      prompt: m[1],
      width: m[2] ? parseInt(m[2], 10) : undefined,
      height: m[3] ? parseInt(m[3], 10) : undefined,
      raw: m[0],
    });
  }
  for (const m of text.matchAll(
    /\{"myagent_tool"\s*:\s*"generate_image"[^}]*"prompt"\s*:\s*"((?:\\.|[^"\\])*)"[^}]*\}/gi
  )) {
    const raw = m[0];
    if (out.some((o) => o.raw === raw)) continue;
    let prompt = m[1].replace(/\\"/g, '"');
    const w = raw.match(/"width"\s*:\s*(\d+)/i);
    const h = raw.match(/"height"\s*:\s*(\d+)/i);
    out.push({
      prompt,
      width: w ? parseInt(w[1], 10) : undefined,
      height: h ? parseInt(h[1], 10) : undefined,
      raw,
    });
  }
  return out;
}
