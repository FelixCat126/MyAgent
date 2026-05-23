# MyAgent

跨平台 **Electron** 桌面 AI 对话应用。支持多模型、本地/云端推理、会话持久化、联网检索、工作区与向量知识库、常见办公文档与表格、图像生成与图片库，以及中英界面与亮/暗/跟随系统主题。

**远程仓库**：<https://github.com/FelixCat126/MyAgent>

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **多模型** | OpenAI 兼容 API、Ollama、Claude、Gemini 等；可选 **SSE 流式**（取决于接口与模型）。流式异常时**保留已输出内容并附错误**；若尚未产生可见正文即停止，**不留下空头助手气泡**。 |
| **语音输入** | **Electron** 下可配置 **火山引擎豆包 OpenSpeech** 双向流式识别（主进程 WebSocket + V1 协议，渲染进程 **AudioWorklet** 采集与 16 kHz PCM）；支持点击结束与约 **3 秒无新识别结果自动结束**。未配置火山时，可按环境回退 **Web Speech API** 或 **兼容 API 的单次转写**（与当前模型 API 相关）。 |
| **会话** | 多会话、搜索、重命名、删除、未读提示；整段会话导出 **Markdown / HTML**。 |
| **附件** | 图片（多模态视模型支持）、**xlsx / docx / md / txt** 等由主进程解析后注入上下文；大文件受**体积与提取字数**限制，超限会截断并带说明。 |
| **联网** | 由关键词或 `/web` 等策略触发；免 Key 可走 **DuckDuckGo** 类链路，可选 **Tavily / Brave**（需 API Key）。 |
| **工作区与 RAG** | 配置本机**工作区根路径**；可节选约定知识文件；**向量索引**使用独立嵌入配置（本机 Ollama 或云端，含方舟 **多模态嵌入**路径开关）。**「为当前工作区建索引」** 单按钮：在可复用指纹且根目录与模型一致时走**智能增量**（仅变更或未索引文件重新分块与请求嵌入），否则内部退化为**全文重建**。对话发送前可按相关度注入片段（不写入聊天记录）。 |
| **界面与设置** | **中文 / 英文**；亮 / 暗 / **跟随系统**；字体与自动保存；新用户引导可跳过。设置内主要区块**默认折叠**；**流式输出**、**语音输入**、知识库「对话时引用」及模型表单的**本地模型 / 生图工具**等采用**开关**样式；嵌入「高级」项可折叠。 |
| **助手展示与导出** | **Markdown + GFM**；代码块与判定的**类源码整段回复**支持**一键复制**；单条回复可导出 **.md / .xlsx / .docx**（表格导出依赖回复中的 Markdown 表格）。 |
| **生图与系统** | 模型侧约定 JSON 触发生图；支持 **CLI**、**HTTP**、**OpenAI Images 兼容**（含方舟等）等配置方式；**图片库**浏览本应用产生的图片。**单实例**：重复启动会唤起已有窗口；剪贴板与「启动本机应用」等能力以实际 preload 暴露为准。 |

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

当前规模：**34 个测试文件 / 208 条用例**，覆盖渲染端工具与状态、Electron 主进程协议 / IPC 纯函数、文档解析与导出，以及关键 React 组件的桌面/移动壳分流。`src/test/setupTests.ts` 提供最小 Electron API stub、以及对 jsdom 缺失的 `URL.createObjectURL` 的占位（便于断言附件「fetch → 伪装下载锚点」链路）。

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

下列流程涉及真实网络、外部进程或 GPU，本仓库**不**做自动化（仅手工矩阵验证）：

- 模型 SSE 实时流式与中断恢复
- 生图全链路（CLI / SD WebUI / OpenAI Images / 多图序列）
- 火山 ASR WebSocket 握手 / 重连 / 长连维护
- 向量索引磁盘读写与全量回退的端到端
- 远端网关在真实 HTTP 服务上的鉴权与 SSE 转发
- electron-builder 安装包烟雾测试

增补新特性时优先为**无副作用的纯函数**与 **IPC 入参 / 分支**补齐用例。

---

## 配置说明（摘要）

以下与界面文案一致，细节以应用内为准。

1. **模型**：添加提供商、API 地址、密钥、模型名；可开关 **本地模型**、**作为生图工具**并配置 CLI/HTTP/兼容 Images 等。  
2. **流式输出**：在「应用与隐私」中开关；关则非流式请求（视接口而定）。  
3. **语音输入**：同一区域开关；开启后可填 **火山 OpenSpeech** 三项密钥（仅火山协议）。麦克风按钮在连接建立前会显示加载态。  
4. **工作区**：填写本机资料目录路径；知识库可选 **本机 Ollama** 或 **云端** 嵌入，高级里可改地址、模型、召回条数与注入字数上限等。  
5. **联网**：总开关与提供商、可选 API Key。  

火山语音与嵌入的官方文档见 [豆包语音](https://www.volcengine.com/docs/6561/1354869?lang=zh) 与控制台说明（嵌入 Base 须与文档一致，如 `…/api/v3`）。

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
