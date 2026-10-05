# MyAgent 1.3.0 验收记录

验收日期：2026-10-06。自动测试使用合成文件、独立 profile 和本地 HTTP 模型服务，没有使用真实 API 密钥，也没有改动实际用户配置。

最终全量回归：126 个测试文件、870 项全部通过；TypeScript 和生产构建通过。最终本地签名 App 的实际桌面验收、DMG/ZIP 完整性与内部签名均通过。应用和安装包保持 1.3.0，配置目录保持原位置，没有增加版本号。

| 范围 | 已验证内容 | 证据 |
| --- | --- | --- |
| 界面精简 | 工作空间、图片工作台及收藏/编辑版本入口移除；顶栏右侧只留任务图标，保留悬停提示、读屏名称、打开关闭/Escape；生图选择区分隔线前后各 16px、控件间 8px | AppWorkspaceIntegration tests；实际桌面/窄窗像素布局、中英文任务入口及任务记录截图 |
| 旧数据兼容 | 旧项目/记忆/配方/收藏记录保留；旧规则、目录和全部工作空间记忆不再自动应用；记住/忘掉请求走普通模型，新发送/编辑重发/旧任务恢复不改旧记忆 | personal/sendPipeline/runtimeExecution tests；Electron 旧数据启动与正常退出重启验收 |
| 配置界面与整理 | 一个模型配置入口、四页签、跨页保留草稿、共享服务变更/删除、CLI 参数清空、图片/视频独立认证、旧配置自动整理及写入失败回退 | ModelSettingsHub/Models/Video tests；实际 App 六模型旧配置整理为五服务，原默认/生图配置保留，模型与服务密钥落盘加密 |
| 对话导航 | 统一历史列表，无分类/归属标签；旧项目及失效项目的历史都可打开；浏览不改当前会话；单行新对话按钮 | SessionList/personal/App 挂载 tests；实际 App 历史保留、中文浅色/英文深色和窄窗口截图 |
| 流式显示 | 实时正文约 50 中文字/秒、思考和已完成的 Agent 答案约 100 字/秒；按实际经过时间推进，界面渲染耗时不逐字累加，标点不再强制停顿；掉帧单次最多补两个中文字，停止后不继续播放。Agent 回答仍须先完成工具调用与内容校验 | runModelReplyShared.stream/replyTaskCompletion tests；实际 App 对话与停止路径 |
| 连接与诊断 | 共用服务、发现模型、O/A 协议、配置变更失效、独立诊断 | connectionStore/model-service 真实 loopback HTTP；实际 preload IPC |
| 模型发现 | 已有模型勾选并适度灰化，深色模式下选中对勾清晰；只新增新勾选模型；默认/旧配置不变；重新发现和重启可识别新增模型；MiMo O/A 均使用同 origin 的官方 `/v1/models`；空列表/HTTP 404 持续提示及重试 | ConnectionsSection 15 项、model-service 28 项回归；实际 App 列表、添加、空列表、重试 404 与重启；深色模式截图及计算样式对比度 |
| 工具与恢复 | O/A 原生工具 ID/签名、JSON 兼容、参数校验、取消、持久步骤、MCP 防重复写；旧任务恢复时刷新生成上下文并保留工具结果，不受旧项目状态阻塞 | nativeModelProtocol/toolRegistry/durableTools/taskBridge/runtimeExecution/runtimeContext tests |
| 文档 | 真 PDF 提取与栅格、离线扫描 OCR、页码与置信度、预览编辑比较恢复 | pdf/service/DocumentWorkbenchPanel；真实 Electron 28 及最终 asar |
| 数据 | 真实分组/筛选/同比、十进制小数、来源/范围、读取变更保护、Excel/CSV/SVG | data/service tests；实际对话调用计算并下载成果 |
| 图片与视频 | 对话生图与图片预览下载保留；底层 HTTP/SD 生成和编辑适配、视频异步查询/取消/恢复；旧媒体工作台事件不能打开页面 | AppWorkspaceIntegration/image HTTP/SD/video adapter tests；实际 App 退休事件验收 |
| 语音与快捷窗口 | 听写取消、TTS 打断、简要朗读、独立窗口 submit/cancel/open IPC | voice tests；真实 Electron 快捷窗口截图和 IPC 验收 |
| 定时与 MCP | 提醒、监控、错过任务处理、stdio/HTTP、一次性批准及断开超时 | scheduler/MCP 实际 stdio integration/runtime UI tests |
| 备份与升级 | 加密、可移植密钥、冲突/路径迁移、旧 store 写屏障、事务回滚、完整托管附件；旧项目元数据只作兼容保存，恢复不会重启项目功能 | backup/runtimeSecrets/zustandFileStorage tests；本轮旧数据实际启动与重启；此前真实 1.2.0 → 1.3.0 隔离目录升级验收 |
| 发布 | TypeScript、全量回归、实际 asar、界面截图、配置重启、新应用图标、签名与安装包 | scripts/workbench-smoke.mjs；release 目录；包内 icon.icns 与源图标核对 |

## 复现

```sh
npm ci
npm test
npm run build
node scripts/workbench-smoke.mjs
```

macOS arm64 本地打包完成后，可用 `MYAGENT_SMOKE_BINARY` 指定 App 内可执行文件运行同一验收。`MYAGENT_SMOKE_OCR_FIXTURE` 可指定合成扫描 PDF，额外运行实际打包 OCR/栅格验证。脚本为每轮新建独立 profile，不读写用户资料。

本轮新签名包启动时，系统钥匙串授权阻塞了主线程，尚未进入界面验收。为完成界面与配置重启检查，本轮显式设置 `MYAGENT_SMOKE_ISOLATED_CREDENTIALS=1`：测试脚本在应用执行前，只为自己的隔离进程安装临时 AES-GCM 凭证夹具，密钥仅在该轮重启之间复用，不进入报告或产品代码。报告标明 `credentialStorage=isolatedEncryptedFixture`、`systemKeychainVerified=false`。因此本轮验证了配置加密与重启读回流程，没有替代系统钥匙串授权验证；此前真实钥匙串升级验收仍单独保存。

本轮真实 App 验收生成 17 张截图，含模型发现成功/错误页、深色模式模型列表、任务中心和生图选择间距。深色模式同屏比较“已添加”和可添加模型：已有项适度灰化，14px 文字实测对比度 9.85:1；可添加项为 16.30:1；已选中对勾与背景为 10.84:1。原生复选框仍保持 checked/disabled 状态。Dock/安装包图标换为科技感 M 图形，1024px 与 64/32/16px 浅色、深色背景预览已检查，App 内 icon.icns 已核对。旧历史保留、退休记录兼容、新对话、配置整理与退出重启均通过。工作空间与图片工作台的旧截图不再作为当前验收证据。正在运行的用户 App 没有被终止或写入，实际旧配置将在更新后的 App 首次启动时自动整理。

最终统计与安装包散列见 release/verification-1.3.0.txt。生产依赖 npm audit 为 0；这不代表整个 Electron 平台或所有开发依赖没有既有风险。构建工具仍有非阻断的 bundle 大小和 Browserslist 提示。

此前的 1.2.0 → 1.3.0 真实安装包升级验收中，旧版没有测试目录开关，升级探针在产品代码执行前暂停，确认隔离的 appData/documents/userData 后才恢复执行。两版本均正常退出；新版本读取旧版加密凭证成功，磁盘与升级快照中凭证继续加密。历史证据见 release/upgrade-log-1.3.0.txt。本轮使用新的最终 App 独立验证旧项目数据、模型配置整理及重启保留。

明确支持范围和限制见 myagent-1.3.0-guide.md。厂商实时额度/账号权限以及真实音频设备未被合成验收替代。
