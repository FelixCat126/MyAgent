import type { Locale } from '../i18n/types';

export type AgentCapabilityFlags = {
  localEnabled?: boolean;
  browserEnabled?: boolean;
};

export function buildAgentCapabilitySystem(
  locale: Locale,
  workspaceRoot: string,
  homeDir: string,
  flags?: AgentCapabilityFlags
): string {
  const localOn = flags?.localEnabled !== false;
  const browserOn = flags?.browserEnabled !== false;
  const ragHint = workspaceRoot.trim()
    ? locale === 'en'
      ? `Vector semantic search (mode semantic) uses indexed workspace: ${workspaceRoot.trim()}`
      : `语义检索（mode: semantic）使用已建索引的工作区：${workspaceRoot.trim()}`
    : locale === 'en'
      ? 'Semantic search falls back to filename search when no workspace index exists.'
      : '未配置工作区索引时，语义检索会退化为按文件名搜索。';

  if (locale === 'en') {
    const localBlock = localOn
      ? 'Local files: search/read/list/export on this computer (user home, external volumes). ' +
        'For finding EXISTING photos on disk, use local_search with mode "image" — do NOT use AI image generation. ' +
        'OS core dirs (/System, /etc, C:\\Windows) are blocked. Extra denied paths in Settings.\n' +
        '{"myagent_tool":"local_search","query":"...","mode":"semantic|filename|image","limit":3}\n' +
        '{"myagent_tool":"local_list","subpath":"~/Documents or absolute path","maxDepth":3}\n' +
        '{"myagent_tool":"local_read","path":"absolute or ~/relative path"}\n' +
        '{"myagent_tool":"local_export","format":"md|docx|xlsx","content":"markdown body","name":"basename"}\n'
      : 'Local file tools are disabled in Settings.\n';
    const webBlock = browserOn
      ? 'Web automation: use the **embedded panel below the chat** (not a separate window). ' +
        'If the user asks what a website is: web_open the URL, then web_read, then answer from the snapshot — never reply "waiting for instructions". ' +
        'For Baidu/Google search, prefer direct search URLs instead of multi-step form clicks. ' +
        'Baidu image: https://image.baidu.com/search/index?tn=baiduimage&word=KEYWORD ; ' +
        'Google image: https://www.google.com/search?tbm=isch&q=KEYWORD — use web_eval to read first result img when user asks for an image.\n' +
        '{"myagent_tool":"web_open","url":"https://..."}\n' +
        '{"myagent_tool":"web_read","selector":"main"}            // selector optional; default = visible body text\n' +
        '{"myagent_tool":"web_eval","js":"document.querySelector(\'input[name=q]\').value=\'hello\'; document.querySelector(\'form\').submit(); return location.href;"}\n' +
        '{"myagent_tool":"web_close"}\n'
      : 'Embedded browser tools are disabled in Settings.\n';
    return (
      '【MyAgent tools】\n' +
      localBlock +
      webBlock +
      'Emit one JSON object per line (no markdown fence). After every tool call, wait for the system to return its result before issuing more JSON.\n' +
      `Relative paths resolve under user home: ${homeDir}\n` +
      `${ragHint}\n` +
      'Do NOT ask the user to upload or to operate the browser themselves when tools are enabled. ' +
      'Never repeat the same tool JSON if the system reports it was already executed; then answer in plain language. ' +
      'Summarize results in natural language; do not leave tool JSON in the final answer.'
    );
  }

  const localBlockZh = localOn
    ? '本机文件：可检索、列出、读取与导出文档（主目录、外置磁盘等）；' +
      '若用户要在本机找**已有**照片/图片，请用 local_search 且 mode 为 image，禁止 AI 生图；' +
      '操作系统核心目录内置禁止，用户还可在设置「Agent 非授权路径」追加禁止目录。\n' +
      '{"myagent_tool":"local_search","query":"...","mode":"semantic|filename|image","limit":3}\n' +
      '{"myagent_tool":"local_list","subpath":"~/Documents 或绝对路径","maxDepth":3}\n' +
      '{"myagent_tool":"local_read","path":"绝对路径或 ~/ 相对路径"}\n' +
      '{"myagent_tool":"local_export","format":"md|docx|xlsx","content":"Markdown 正文","name":"文件名"}\n'
    : '本机文件工具未在设置中开启。\n';
  const webBlockZh = browserOn
    ? '浏览器自动化：在**对话区下方的内嵌面板**中打开网页（不是弹新窗口）；窗口在多轮对话中保留，后续追问可继续 web_read / web_eval 操作同一页。' +
      '若用户问「这是什么网站」：必须先 web_open → web_read 读页面，再依据快照回答，禁止回复「等待用户指令」等空话。' +
      '百度/谷歌搜索请直接用搜索 URL，不要多步点表单。' +
      '百度图片：https://image.baidu.com/search/index?tn=baiduimage&word=关键词 ；' +
      '谷歌图片：https://www.google.com/search?tbm=isch&q=关键词 ；用户要「第一张图」时用 web_eval 取结果区 img。\n' +
      '{"myagent_tool":"web_open","url":"https://..."}\n' +
      '{"myagent_tool":"web_read","selector":"main"}           // selector 可省略，默认抓全页可见文字\n' +
      '{"myagent_tool":"web_eval","js":"document.querySelector(\'input[name=q]\').value=\'hello\'; document.querySelector(\'form\').submit(); return location.href;"}\n' +
      '{"myagent_tool":"web_close"}\n'
    : '对话内嵌浏览未在设置中开启。\n';

  return (
    '【MyAgent 工具集】\n' +
    localBlockZh +
    webBlockZh +
    '请逐行输出 JSON（不要用代码围栏）；每发出一条工具 JSON 后请等待系统返回结果再发下一条：\n' +
    `相对路径默认以用户主目录为基准：${homeDir}\n` +
    `${ragHint}\n` +
    '工具可用时禁止要求用户提供文档名/上传/自行点击浏览器。' +
    '若系统提示工具已执行过，禁止重复输出相同 JSON，应直接根据已有结果用自然语言回答。' +
    '工具执行后请用自然语言总结，最终回答中不要保留工具 JSON。'
  );
}
