# MyAgent

跨平台 **Electron** 桌面 AI 对话应用。支持多模型、本地/云端推理、会话持久化、联网检索、工作区与向量知识库、常见办公文档与表格、图像生成与图片库，以及中英界面与亮/暗/跟随系统主题。

**1.3.0** 提供文档版本与离线 OCR、真实表格计算、持久视频任务、快捷窗口、定时监控、MCP 和加密备份。对话使用统一历史列表，任务中心收为顶栏右侧图标；工作空间和图片工作台已移除。模型发现会清晰标记已添加项，流式回复按稳定节拍逐字呈现，并换用新的应用图标。安装与支持范围见 [使用说明](docs/myagent-1.3.0-guide.md)，验证方法见 [验收记录](docs/workbench-acceptance.md)。

**远程仓库**：<https://github.com/FelixCat126/MyAgent>

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **多模型** | 同一配置支持 **OpenAI Chat Completions（O 家兼容）**与 **Anthropic Messages（A 家兼容）**，可自动识别或手动指定；另支持 Ollama、Claude、Gemini 等。OpenAI / Anthropic / Ollama 兼容接口可选 **SSE 流式**。流式异常时**保留已输出内容并附错误**；若尚未产生可见正文即停止，**不留下空头助手气泡**。 |
| **语音输入** | **Electron** 下可配置 **火山引擎豆包 OpenSpeech** 双向流式识别（主进程 WebSocket + V1 协议，渲染进程 **AudioWorklet** 采集与 16 kHz PCM）；支持点击结束与约 **3 秒无新识别结果自动结束**。未配置火山时，可按环境回退 **Web Speech API** 或 **兼容 API 的单次转写**（与当前模型 API 相关）。 |
| **会话** | 多会话、统一历史列表、搜索、重命名、删除、未读提示。整段会话导出 **Markdown / HTML**。 |
| **附件** | 图片（多模态视模型支持）、**xlsx / docx / md / txt** 等由主进程解析后注入上下文；大文件受**体积与提取字数**限制，超限会截断并带说明。 |
| **联网** | 由关键词或 `/web` 等策略触发；免 Key 可走 **DuckDuckGo** 类链路，可选 **Tavily / Brave**（需 API Key）。 |
| **工作区与 RAG** | 配置本机**工作区根路径**；可节选约定知识文件；**向量索引**使用独立嵌入配置（本机 Ollama 或云端，含方舟 **多模态嵌入**路径开关）。**「为当前工作区建索引」** 单按钮：在可复用指纹且根目录与模型一致时走**智能增量**（仅变更或未索引文件重新分块与请求嵌入），否则内部退化为**全文重建**。对话发送前可按相关度注入片段（不写入聊天记录）。 |
| **界面与设置** | **中文 / 英文**；亮 / 暗 / **跟随系统**；字体与自动保存；新用户引导可跳过。**设置 → 模型配置**以四个标签统一管理对话与图片、视频模型、服务连接、语音与回答；高级参数按需展开。 |
| **助手展示与导出** | **Markdown + GFM**；代码块与判定的**类源码整段回复**支持**一键复制**；单条回复可导出 **.md / .xlsx / .docx**（表格导出依赖回复中的 Markdown 表格）。 |
| **生图与系统** | 模型侧约定 JSON 触发生图；支持 **CLI**、**HTTP**、**OpenAI Images 兼容**（含方舟等）等配置方式；**图片库**浏览本应用产生的图片。**单实例**：重复启动会唤起已有窗口；剪贴板与「启动本机应用」等能力以实际 preload 暴露为准。 |
| **文档与数据工作台** | 文档预览、编辑、版本比较与恢复；扫描 PDF 中英文离线 OCR；Excel/CSV 真实计算、图表及成果文件。 |
| **任务中心** | O/A 原生工具调用与兼容回退、任务检查点、定时提醒与监控、MCP、完整加密备份；模型服务与能力诊断在「设置 → 模型配置」。 |
| **媒体与快捷对话** | 对话生图与预览下载、MiniMax v1 视频异步任务；独立快捷窗口、语音状态与打断。 |

### 文档与表格

- **旧版 `.xls` / `.doc`** 建议先另存为 **`.xlsx` / `.docx`** 再上传。  
- 复杂**公式、宏、只读二进制布局**以解析出的文字与模型理解为主，非完整电子表格重算引擎。  
- 导出 **xlsx** 时，尽量让模型使用标准 **GFM 管道表格**；无表格时导出可能为占位说明。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面 | **Electron 28+**，**Vite**，**electron-builder** |
| 前端 | **React 18**、**TypeScript**、**Tailwind CSS**、**Zustand** |
| 主进程 | **axios**、**ws**（流式 ASR）、**ExcelJS**、**mammoth**、**docx** 等 |
| 渲染 | **react-markdown** + **remark-gfm** |

---

## 快速开始

**环境**：Node.js **18+**，npm 或 yarn。

```bash
# 国内镜像（可选）
npm config set registry https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

npm install
npm run dev          # 开发
npm run build        # 类型检查 + 渲染与主进程构建
npm run test         # Vitest（见下文「自动化测试」）

npm run package      # 当前平台安装包
npm run package:mac / package:win / package:linux
```

> **macOS 代码签名**：未配置 Apple Developer 证书时，安装包可能为未签名状态；对外分发需自行完成签名与公证。

---

## 自动化测试

使用 **Vitest**（配置见项目根目录 `vitest.config.ts`，与 Electron 插件隔离；默认环境 **jsdom**，主进程相关用例顶部声明 `// @vitest-environment node`）。运行：

```bash
npm run test
```

测试覆盖渲染端状态与组件、主进程协议、真实文件与子进程、工具恢复、取消、权限范围和备份事务。最终统计见 [验收记录](docs/workbench-acceptance.md) 和 `release/verification-1.3.0.txt`。`src/test/setupTests.ts` 为单元测试提供 Electron API stub；真实桌面链路由独立验收脚本验证。

### 业务域 ↔ 测试文件

| 业务域 | 测试文件 |
|--------|----------|
| **附件 / 图片下载**（已知扩展名保留、Electron 取消 / 源缺失、fetch fallback） | `src/utils/imageDownload.test.ts` |
| **会话图库与图片库**（仅 `image/`、顺序、`data:` 预览、basename） | `src/utils/conversationImageGallery.test.ts` |
| **预览弹层桌面/远端分流**（下载按钮 vs 长按提示、英文 locale） | `src/components/MessageItem.test.tsx` |
| **火山 OpenSpeech V1 帧**（full client / audio / 服务端 result / error 解析） | `electron/utils/volcOpenspeechProtocol.test.ts` |
| **工作区索引切块**（段聚合、超长切片、CRLF 归一化） | `electron/utils/chunkText.test.ts` |
| **嵌入客户端**（OpenAI / 方舟 / Ollama 路径、批分组、多模态、错误透传） | `electron/utils/embeddingClient.test.ts` |
| **文档提取**（md / txt 直读、docx 调 mammoth、xlsx → GFM 表、xls/doc 引导文案） | `electron/utils/documentText.test.ts` |
| **Markdown 导出**（GFM 表解析、`markdownToXlsxBuffer`、`plainMarkdownToDocxBuffer`） | `electron/utils/markdownExport.test.ts` |
| **知识库索引复用判定**（指纹归一、根/模型/dim 校验、增量可否复用） | `electron/utils/knowledgeIndexOperations.test.ts` |
| **远端网关**（配置合并 / 反代路径归一化 / mime / 静态资产 / 鉴权 / multipart） | `electron/ipc/remote-gateway.test.ts` |
| **文档导出意图 / 联网触发 / GFM 检测** | `documentExportIntent.test.ts`、`webSearchTrigger.test.ts`、`markdownTableDetect.test.ts` |
| **消息清洗 / 工具调用 JSON 提取 / 单文件代码检测** | `sanitizeMessagesForModel.test.ts`、`toolCalls.test.ts`、`standaloneCodeDetect.test.ts` |
| **向量数学 / RAG 选取 / 嵌入解析与 baseUrl 归一** | `vectorMath.test.ts`、`ragRelevance.test.ts`、`embeddingParse.test.ts`、`embeddingNormalize.test.ts` |
| **Zustand 状态**（chat / model / setting / webSearch / workspace） | `src/store/*.test.ts` |
| **SSE 增量解析**（主进程） | `electron/utils/streamChatCompletionDelta.test.ts` |
| **应用壳挂载**（最少渲染） | `src/App.test.tsx` |

### 仍依赖手工 / E2E 的链路

`node scripts/workbench-smoke.mjs` 自动验证真实 Electron 的 preload、界面发送、数据工具、成果文件、文档编辑/恢复、配置重启和正常退出；模型服务采用本地 HTTP fixture。单元/集成测试还验证实际 CLI 取消、PDF/OCR 和 stdio MCP。下列环境能力仍需要对应设备或账户验证：

- 云端模型账户权限、额度和厂商实时行为
- 本机 GPU 生图质量与实际模型耗时
- 火山 ASR WebSocket 握手 / 重连 / 长连维护
- 实际音频设备和系统权限
- Apple 公证及 Windows/Linux 安装体验

增补新特性时优先为**无副作用的纯函数**与 **IPC 入参 / 分支**补齐用例。

---

## 配置说明（摘要）

以下与界面文案一致，细节以应用内为准。

1. **模型**：统一入口为 **设置 → 模型配置**，包含「对话与图片」「视频模型」「服务连接」「语音与回答」四个标签。服务地址和密钥可共用；对话协议默认自动识别，也可选 **Anthropic Messages（A）**或 **OpenAI Chat Completions（O）**。本地 CLI、HTTP 和兼容 Images 生图工具在「对话与图片」中管理。
2. **流式输出**：在「模型配置 → 语音与回答」中开关；关则非流式请求（视接口而定）。
3. **语音输入**：在同一标签开启，展开「火山语音识别服务」可填 **火山 OpenSpeech** 三项密钥（仅火山协议）。麦克风按钮在连接建立前会显示加载态。
4. **工作区**：填写本机资料目录路径；知识库可选 **本机 Ollama** 或 **云端** 嵌入，高级里可改地址、模型、召回条数与注入字数上限等。  
5. **联网**：总开关与提供商、可选 API Key。  

火山语音与嵌入的官方文档见 [豆包语音](https://www.volcengine.com/docs/6561/1354869?lang=zh) 与控制台说明（嵌入 Base 须与文档一致，如 `…/api/v3`）。

更新后的应用启动时，会将可确认设置一致的旧对话模型自动整理到服务连接，并保留原模型、密钥、协议、默认选中项与 CLI 参数；其他配置保留为独立配置。

左栏直接显示全部历史对话，可搜索、重命名、导出和删除。项目、工作空间和图片工作台已移除，任务中心从顶栏右侧时钟图标打开。旧对话、附件、模型配置及兼容元数据保留；旧项目规则、目录和个人记忆不再自动应用，配方和收藏入口停用。

---

## 项目结构（节选）

```
myagent/
├── electron/
│   ├── main.ts
│   ├── preload.cjs
│   ├── ipc/
│   │   ├── model.ts / model-stream.ts   # 模型调用与 SSE 流式
│   │   ├── knowledge.ts                 # 工作区索引与向量检索 IPC
│   │   ├── volc-stream-asr.ts           # 火山 OpenSpeech 流式 ASR
│   │   ├── speech-transcribe.ts         # 单次转写等（若启用）
│   │   ├── web-search.ts
│   │   ├── image-gen.ts
│   │   ├── file.ts / export.ts / documents.ts / …
│   └── utils/
│       ├── volcOpenspeechProtocol.ts    # OpenSpeech V1 帧
│       ├── knowledgeIndexOperations.ts / vectorIndexPersistence.ts / workspaceIndex.ts
│       ├── embeddingClient.ts           # 嵌入与方舟多模态路径
│       ├── documentText.ts / markdownExport.ts / …
├── src/
│   ├── components/      # ChatWindow, SettingsPanel, MessageItem, …
│   ├── hooks/           # useWebSpeechDictation 等
│   ├── store/           # chat / model / knowledge / setting / …
│   ├── i18n/ui.ts
│   └── utils/           # enrichMessagesForModel, pcmDownsample, …
├── docs/                # 需求清单、架构设计
├── vite.config.ts
└── electron-builder.yml
```

---

## 数据与隐私

- 会话与设置等主要落在本机 **Electron `userData`** 策略下（开发包与安装包在同一机器上的目录规则以实际为准）。  
- 持久化带**防抖**，并在 `beforeunload` 时尽量冲刷，降低数据丢失窗口。  
- **联网**仅在满足触发条件时访问已配置的搜索服务。  
- 处理敏感数据前请自行评估**模型与 API** 的合规与出境要求。

常见数据目录示例：`~/Library/Application Support/…`（macOS）、`%APPDATA%\…`（Windows）、`~/.config/…`（Linux）。

---

## 常见问题

| 现象 | 建议 |
|------|------|
| 依赖或 Electron 安装失败 | 清缓存重试；使用镜像；检查代理与 Node 版本。 |
| 打包失败 | 准备对应平台的构建依赖（如 Xcode CLI、Windows 构建链）；见 electron-builder 文档。 |
| 联网超时或摘要为空 | 免 Key 链路受网络与服务影响；稳定场景可改用 Tavily/Brave 并检查 Key。 |
| 语音识别握手失败 | 核对火山控制台 **OpenSpeech / 智能语音** 的 App Key、Access Key、Resource Id（勿与方舟对话 Key、`ep-` 混用）。 |

---

## 后续方向（非承诺路线图）

| 方向 | 说明 |
|------|------|
| 结构化工具调用 | 扩展 function calling / 稳定的工具编排。 |
| 技能与插件 | 可配置工作流；第三方插件需严格安全模型。 |
| 记忆与画像 | 本地摘要与偏好检索（注意隐私与体积）。 |
| 语音闭环 | **TTS** 与连续语音对话等（当前以听写与文本对话为主）。 |
| 表格 / 协作等 | 沙箱内计算、多人审阅等，按需求评估。 |

当前版本侧重：**本地化数据、多模型与流式对话、文档与表格、联网与向量工作区、生图与图片管理、Electron 火山流式听写（可选）**。

---

## License

MIT

## 贡献

欢迎 Issue 与 Pull Request。

### 简化配置与图片任务

- 设置 → 模型配置 → 对话与图片 → 添加模型：先选「对话」「生成图片」或「对话和图片」。图片服务预设会填入地址和模型名；显示名称可留空自动生成。服务连接统一在同页「服务连接」标签管理。
- 纯图片模型不参与对话模型选择。图片工具可使用服务连接的密钥或独立密钥，本地 CLI 参数继续在图片模型中配置。清空独立图片密钥并保存会删除该字段，不再恢复旧值。
- 协议、输出长度、上下文容量、CLI 参数、环境变量和模型路由保留在高级设置。旧配置仍可读取；自动协议不会在保存时固化为某一种协议。
- 上下文容量可按实际服务设置；未知服务使用保守预算并预留输出空间，界面的用量为估算值，不代表厂商实际窗口。
- 生图只有收到结构化工具调用才执行，关键词本身不会触发付费请求。用户的图片数量优先于模型建议，单轮总数最多 12 张；多人场景不再被当成多张图片。
- 「上一张」「第二张」从最近一组图片中选择参考图，本轮上传图片优先。OpenAI GPT Image 使用编辑接口，Seedream 使用参考图；尚未接入编辑的服务会明确报错，不会忽略原图后重新文生图。
- 停止操作会取消本机 HTTP/CLI 工作并阻止后续补图，已完成的图片保留；服务端已受理的请求是否仍产生费用由服务商决定。不同云服务与本地 GPU 队列互不阻塞。

### 文件生成与排版

- 可直接要求 Word（DOCX）、PDF、Excel（XLSX）、Markdown、TXT、CSV，也可同时要求多个格式。明确格式优先；讨论下载方法或明确不生成文件时，不进入自动生成。
- “把刚才的内容转成 PDF”会复用上一条正文直接转换。带修改、翻译等要求时仍交给模型处理；已生成文档的正文保留在会话中，供后续修改使用。
- 文件写入成功后显示附件，点击文件名或下载图标保存副本。一个格式失败不影响已完成附件；错误消息保留正文，并可重试缺失的格式。
- Word/PDF 使用 A4、中文字体、分级标题、真实表格、跨页表头和页码。PDF 与 Word 使用同一 Markdown 结构解析；手动导出与自动附件共用生成器。
- Excel 自动设置列宽、换行行高、冻结表头和筛选，并识别普通数值与百分比，保留编号前导零和长数字。Excel/CSV 必须包含表格；CSV 多表会明确拒绝，避免丢弃其他表。
- 当前不生成 PPT、EPUB 等格式；不会以更换扩展名或生成另一格式冒充支持。自动文件保存在系统文档目录的 `MyAgent/GeneratedDocuments`。
