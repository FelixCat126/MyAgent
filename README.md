# MyAgent

跨平台本地 AI 对话应用（Electron）。支持多模型、会话持久化、联网检索、工作区知识注入、表格/文档理解与导出，以及中英界面与亮暗色（可跟随系统）。

**远程仓库**：<https://github.com/FelixCat126/MyAgent>

---

## 核心能力一览

| 能力 | 说明 |
|------|------|
| **多模型** | OpenAI 兼容、Ollama、Claude、Gemini 等；支持 **SSE 流式**（与模型能力相关）；**中途失败保留已打印内容并在末尾附上错误**，未出字即停止则无空头泡干扰。 |
| **会话** | 多会话、重命名、删除、未读提醒、导出整段会话为 **Markdown / HTML** |
| **附件** | 图片多模态（视模型支持）、**Excel / Word / Markdown / 文本** 等：主进程解析后注入对话；对大文件可提高 stat 阈值并对提取正文按**字数上限截断**（提示随上下文注入），减轻超大附件压力。 |
| **联网** | 关键词或 `/web` 等触发；免 Key 走 DuckDuckGo 等链路，可选 **Tavily / Brave**（需 API Key） |
| **工作区** | 配置目录后可节选知识文件作文本上下文；**向量索引**支持**全文重建**与**增量更新**（按 `mtime`/大小指纹复用分块向量，变更文件单独重嵌入）。 |
| **界面** | **中文 / 英文** 切换、亮 / 暗 / **跟随系统**；新用户引导（可跳过） |
| **助手消息** | **Markdown + GFM 表格**；**代码围栏**一键复制整块；检测到**整块回复更接近源代码**时使用代码气泡展示；回复可导出 **.md / .xlsx / .docx**。 |
| **工具与自动化** | 生图、启动本机应用、剪贴板联动。**单实例**：重复启动唤起已有窗口。 |

### 文档与表格说明

- 上传 **`.xlsx` / `.docx` / `.md` 等** 后，系统会将可读文本或表格的 Markdown 表示附在发送内容后发给模型。对大附件会尊重**磁盘大小与正文长度上限**，超限部分截断并有提示文案。  
- **旧版 `.xls` / `.doc`** 建议先另存为 **`.xlsx` / `.docx`** 再上传。  
- 希望导出 Excel 时，尽量让模型在回复里使用 **标准 Markdown 管道表格**；无表格时导出 xlsx 会带提示性占位内容。  
- 复杂**公式、宏、只读二进制度量**以模型理解与文字说明为主，并非内置电子表格引擎重算。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面 | **Electron 28+**，Vite 构建，electron-builder 打包 |
| 前端 | **React 18**、**TypeScript**、**Tailwind CSS**、**Zustand** |
| 文档处理（主进程） | **ExcelJS**、**mammoth**（.docx）、**docx**（导出 Word） |
| 渲染 | **react-markdown** + **remark-gfm**（GFM 表格、代码块等） |
| 部署 | 命令行 `npm run package:mac` / `win` / `linux` |

---

## 快速开始

### 环境

- Node.js **18+**
- npm / yarn

### 安装

```bash
# 国内镜像（可选）
npm config set registry https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

npm install
```

### 开发

```bash
npm run dev
```

### 构建与测试

```bash
npm run build   # 类型检查 + 渲染层与主进程构建
npm run test    # Vitest
```

### 打包安装包

```bash
npm run package:mac     # macOS
npm run package:win     # Windows
npm run package:linux   # Linux
npm run package         # 当前平台
```

> **代码签名（macOS）**：未配置 Apple Developer 证书时，可能提示未签名应用；分发需自行完成公证与签名。

---

## 配置说明（摘要）

1. 左下 **New / 新对话**、**语言**、**主题**、**设置**。  
2. **设置** 中可添加模型、配置联网、工作区路径、流式输出等。  
3. **Ollama** 示例：API 地址 `http://127.0.0.1:11434`，模型名如 `llama3`，可勾选本地模型。  
4. **联网**：选用 Tavily / Brave 时请在设置中填写对应 **API Key** 以获得更稳定摘要。  

更细的字段说明以应用内界面为准。

---

## 项目结构（节选）

```
myagent/
├── electron/
│   ├── main.ts
│   ├── preload.cjs
│   ├── ipc/
│   │   ├── model.ts / model-stream.ts   # 模型调用与流式
│   │   ├── file.ts                      # 附件落盘
│   │   ├── export.ts                    # 保存文本、导入等
│   │   ├── documents.ts                 # 文档提取与助手脚手架导出
│   │   ├── web-search.ts                # 联网搜索
│   │   ├── image-gen.ts / persist.ts …
│   └── utils/
│       ├── documentText.ts              # xlsx / docx / md 等 → 模型可读文本
│       ├── knowledgeIndexOperations.ts # 向量索引：全文重建与增量编排
│       └── markdownExport.ts            # 回复中的 MD 表 → xlsx 等
├── src/
│   ├── App.tsx
│   ├── components/                      # ChatWindow, MessageItem, SettingsPanel…
│   ├── store/                           # 会话、模型、设置、工作区…
│   ├── i18n/ui.ts                       # 中英 UI 文案
│   ├── utils/enrichMessagesForModel.ts  # 发送前注入文档正文
│   └── …
├── package.json
├── vite.config.ts
└── electron-builder.yml
```

---

## 数据与隐私

- 对话与设置主要保存在本机 **应用数据目录**（与 Electron `userData` 一致，开发版与安装版共用同一机上的数据策略以实际为准）。持久化写入在渲染进程带有**防抖落盘**，并在页面 `beforeunload` 时尽最大努力冲刷，降低高频写盘的抖动。  
- **联网**仅在关键词或显式 `/web` 等触发时请求已配置的搜索服务。  
- 处理敏感表数据前请确认**模型与 API 路由**是否满足你的合规要求（本地 Ollama 与闭源云 API 风险特征不同）。  

应用数据常见路径（名称以实际 `productName` 为准，示例）：

- **macOS**：`~/Library/Application Support/` 下应用目录  
- **Windows**：`%APPDATA%` 下应用目录  
- **Linux**：`~/.config/` 下应用目录  

---

## 常见问题

**依赖或 Electron 安装失败**  
可尝试清缓存后重试、使用上方镜像、检查 Node 与网络代理。

**打包失败**  
各平台需具备对应构建环境（如 macOS 的 Xcode 命令行工具、Windows 构建链等），详见 electron-builder 文档。

**联网常超时或摘要空**  
免 Key 链路受网络与服务端策略影响；重要场景建议使用 **Tavily / Brave** 并检查代理。

---

## 智能体能力：后续可规划方向

以下为产品级「**智能体**」常考虑的增量能力，**非承诺路线图**，仅便于排期与讨论：

| 方向 | 说明 |
|------|------|
| **结构化工具调用（function calling）** | 为「查天气、调内部 API、写库、跑脚本」等定义稳定工具，由模型发 JSON 参数、应用执行并回传，比纯自然语言更可靠。 |
| **可插拔「技能 / Skill」** | 将一类任务封装为可配置工作流或脚本（如「周报模板」「对账表」），由用户或社区扩展。 |
| **记忆与长期画像** | 在本地向量库或轻量库中做会话摘要、项目偏好检索（需注意隐私与容量）。 |
| **多步任务与检查点** | 明确「计划 → 执行 → 自审」循环，对长任务设步骤上限与人类确认点。 |
| **与浏览器 / 桌面的受控操作** | 在**沙箱与权限**前提下打开链接、抓可见文本等（安全与审核成本高）。 |
| **协作与审阅** | 同一会话分支、比较两版方案、或导出为「待人类批注」的审阅流。 |
| **表格增强** | 在本地用 Python/Node **沙箱**执行受控的 pandas 脚本、或**固定公式**只读重算，减少模型幻觉。 |
| **语音** | 系统自带 STT/TTS 或接第三方，形成语音对话闭环。 |
| **插件市场（慎用）** | 仅当安全模型（签名、隔离）成熟后，再考虑第三方扩展。 |

当前版本已具备：**阅读常见办公文档、表格在对话中展示与导出、联网与工作区、多模型、本地化数据为主** —— 可在此基础上按业务优先级从「**工具调用 + 一两项高价值技能**」逐步演进。

---

## License

MIT

## 贡献

欢迎 Issue 与 Pull Request。
