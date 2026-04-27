# MyAgent - 本地AI助手

一个跨平台的本地AI助手应用，支持多模型配置、对话记忆、多模态上传和本机应用启动。

## 功能特性

- ✅ **扁平化界面** - 现代化UI设计，支持亮色/暗色主题
- ✅ **跨平台支持** - macOS / Windows / Linux
- ✅ **多模型配置** - 支持 OpenAI、Claude、Ollama 等多种模型
- ✅ **对话记忆** - 本地持久化存储，支持搜索和导出
- ✅ **多模态上传** - 支持图片、文档、音频、视频拖拽上传
- ✅ **本机应用启动** - 跨平台应用启动器
- ✅ **一键部署** - 简单的打包命令

## 技术栈

- **桌面框架**: Electron 28+
- **前端框架**: React 18 + TypeScript
- **UI 库**: TailwindCSS
- **状态管理**: Zustand
- **构建工具**: Vite + electron-builder

## 快速开始

### 环境要求

- Node.js 18+
- npm 或 yarn

### 安装依赖

```bash
# 配置国内镜像源（推荐）
npm config set registry https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

# 安装依赖
npm install
```

### 开发模式

```bash
npm run dev
```

### 打包应用

```bash
# macOS
npm run package:mac

# Windows
npm run package:win

# Linux
npm run package:linux

# 所有平台
npm run package
```

## 配置模型

### OpenAI GPT-4

1. 点击右下角设置图标
2. 点击"添加模型"
3. 填写信息：
   - 名称: `My GPT-4`
   - 提供商: `OpenAI`
   - API 地址: `https://api.openai.com/v1`
   - API 密钥: `sk-...`
   - 模型名称: `gpt-4`

### Ollama 本地模型

1. 确保已安装并运行 Ollama
2. 添加模型：
   - 名称: `Ollama Llama 3`
   - 提供商: `Ollama`
   - API 地址: `http://localhost:11434`
   - API 密钥: (留空)
   - 模型名称: `llama3`
   - 勾选"本地模型"

## 项目结构

```
myagent/
├── electron/                    # Electron 主进程
│   ├── main.ts                  # 主进程入口
│   ├── preload.ts               # 预加载脚本
│   ├── ipc/                     # IPC 通信处理
│   │   ├── model.ts             # 模型调用
│   │   └── file.ts              # 文件处理
│   └── utils/                   # 工具函数
│       ├── app-launcher.ts      # 应用启动器
│       └── memory-storage.ts    # 对话存储
├── src/                         # React 渲染进程
│   ├── components/              # UI 组件
│   │   ├── ChatWindow.tsx       # 对话窗口
│   │   ├── SessionList.tsx      # 会话列表
│   │   ├── ModelSelector.tsx    # 模型选择器
│   │   ├── SettingsPanel.tsx    # 设置面板
│   │   ├── FileUploader.tsx     # 文件上传器
│   │   └── MessageItem.tsx      # 消息项
│   ├── store/                   # Zustand 状态管理
│   │   ├── chatStore.ts         # 对话状态
│   │   ├── modelStore.ts        # 模型配置
│   │   └── settingStore.ts      # 设置状态
│   ├── types/                   # TypeScript 类型
│   └── App.tsx                  # 主应用
├── package.json
├── vite.config.ts
└── electron-builder.yml
```

## 使用说明

### 对话功能

1. 点击"新建对话"创建新会话
2. 在输入框输入消息，按 Enter 发送
3. Shift+Enter 换行
4. 点击回形针图标上传文件

### 文件上传

- 支持拖拽上传
- 支持点击图片上传
- 支持类型：图片、PDF、文本、音频、视频
- 大小限制：每个文件最大 50MB
- 数量限制：最多 10 个文件

### 对话管理

- 对话自动保存到本地
- 点击垃圾桶图标删除对话
- 支持搜索对话内容（开发中）
- 支持导出对话为文本文件（开发中）

### 启动本机应用

在对话中输入类似"打开 Safari"的命令，AI会尝试启动对应应用（需要配置工具调用）。

## 数据存储位置

- **macOS**: `~/Library/Application Support/myagent/`
- **Windows**: `%APPDATA%/myagent/`
- **Linux**: `~/.config/myagent/`

对话数据存储在 `chats/` 目录下，每个对话一个 JSON 文件。

## 常见问题

### 依赖安装失败

使用国内镜像源：
```bash
npm config set registry https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
rm -rf node_modules package-lock.json
npm install
```

### 打包失败

确保已安装必要的构建工具：
```bash
# macOS
xcode-select --install

# Windows
npm install --global windows-build-tools

# Linux
sudo apt-get install build-essential
```

## 开发计划

- [ ] 流式输出支持
- [ ] 语音输入/输出
- [ ] 对话搜索功能
- [ ] 对话导出功能
- [ ] 插件系统
- [ ] 云端同步
- [ ] 工作流自动化

## License

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
