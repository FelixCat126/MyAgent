#!/bin/bash

# MyAgent - 环境配置脚本
# 用于配置国内镜像源，加速依赖安装

echo "🚀 开始配置 MyAgent 开发环境..."
echo ""

# 配置 npm 国内镜像
echo "📦 配置 npm 国内镜像源..."
npm config set registry https://registry.npmmirror.com
echo "✅ npm 镜像源已设置为淘宝镜像"
echo ""

# 配置 Electron 镜像
echo "⚡ 配置 Electron 下载镜像..."
echo 'export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/' >> ~/.zshrc
echo 'export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/' >> ~/.zshrc
echo "✅ Electron 镜像配置已添加到 ~/.zshrc"
echo ""

# 应用配置
echo "🔄 应用配置..."
source ~/.zshrc
echo "✅ 配置已生效"
echo ""

# 显示当前配置
echo "📋 当前配置："
echo "npm registry: $(npm config get registry)"
echo "ELECTRON_MIRROR: $ELECTRON_MIRROR"
echo ""

echo "✨ 环境配置完成！"
echo ""
echo "接下来你可以运行："
echo "  npm install        # 安装依赖"
echo "  npm run dev        # 启动开发模式"
echo "  npm run package    # 打包应用"
echo ""
