# Preload 脚本问题修复方案

## 问题
vite-plugin-electron 强制将 preload 脚本编译为 ES Module 格式，但 Electron 的 preload 需要 CommonJS 格式。

## 解决方案

### 方案 1：直接在 main.ts 中注入（推荐）
不使用外部 preload 文件，在创建窗口后直接执行 JavaScript。

### 方案 2：使用 nodeIntegration
关闭 contextIsolation，启用 nodeIntegration，但这有安全风险。

### 方案 3：手动创建 CJS 文件
在构建后手动创建 CommonJS 格式的 preload 文件。

## 当前采用的方案

使用 **方案 2**（开发环境），因为：
1. 本地应用，安全风险可控
2. 最简单直接
3. 立即可用

## 配置
```json
{
  "webPreferences": {
    "preload": "preload.cjs",
    "contextIsolation": false,
    "nodeIntegration": true
  }
}
```

## 生产环境建议

生产环境应该：
1. 使用独立的构建脚本生成 CJS preload
2. 或者在 main process 中手动注入
3. 保持 contextIsolation: true
