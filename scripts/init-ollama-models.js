#!/usr/bin/env node

/**
 * Ollama 模型自动配置脚本
 * 检测本地 Ollama 服务并自动配置已安装的模型
 */

import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

// 获取 Ollama 已安装的模型
async function getOllamaModels() {
  try {
    const response = await axios.get('http://localhost:11434/api/tags', {
      timeout: 5000,
    });
    
    return response.data.models || [];
  } catch (error) {
    console.error('❌ 无法连接 Ollama 服务，请确保 Ollama 正在运行');
    console.error('   启动命令: ollama serve');
    return [];
  }
}

/** 与 App 默认列表一致：不包含 Qwen2.5 系与 gemma4:31b */
function isExcludedOllamaModel(rawName) {
  const name = (rawName || '').toLowerCase();
  if (/qwen2[._]5/i.test(name)) return true;
  if (/^gemma4:31b$/i.test(rawName || '')) return true;
  return false;
}

// 格式化模型名称为友好的显示名称
function formatModelName(modelName) {
  // 移除版本号中的冒号，转换为友好名称
  const nameMap = {
    'qwen3-vl': 'Qwen3-VL',
    'gemma4': 'Gemma4',
  };
  
  let displayName = modelName;
  for (const [key, value] of Object.entries(nameMap)) {
    if (displayName.startsWith(key)) {
      displayName = displayName.replace(key, value);
      break;
    }
  }
  
  return displayName;
}

// 生成模型配置
function generateModelConfig(ollamaModel) {
  const modelName = ollamaModel.name || ollamaModel.model;
  const details = ollamaModel.details || {};
  const paramSize = details.parameter_size || 'Unknown';
  
  return {
    id: `ollama-${modelName.replace(/[:.]/g, '-')}`,
    name: `${formatModelName(modelName)} (${paramSize})`,
    provider: 'ollama',
    apiUrl: 'http://localhost:11434',
    apiKey: '',
    modelName: modelName,
    isLocal: true,
    maxTokens: 8192,
  };
}

// 保存模型配置到用户数据目录
async function saveModelsToStore(models) {
  try {
    const userDataPath = app.getPath('userData');
    const storePath = path.join(userDataPath, 'models.json');
    
    // 读取现有配置
    let existingModels = [];
    try {
      const existing = await fs.readFile(storePath, 'utf-8');
      existingModels = JSON.parse(existing);
    } catch {
      // 文件不存在，使用空数组
    }
    
    // 合并模型（去重）
    const existingIds = new Set(existingModels.map(m => m.id));
    const newModels = models.filter(m => !existingIds.has(m.id));
    const allModels = [...existingModels, ...newModels];
    
    // 保存
    await fs.writeFile(storePath, JSON.stringify(allModels, null, 2), 'utf-8');
    
    console.log(`✅ 成功配置 ${newModels.length} 个新模型`);
    console.log(`📊 总计 ${allModels.length} 个模型`);
    
    return allModels;
  } catch (error) {
    console.error('保存模型配置失败:', error.message);
    return [];
  }
}

// 主函数
async function main() {
  console.log('🔍 检测本地 Ollama 服务...');
  console.log('');
  
  // 初始化 app（用于获取用户数据路径）
  app.setName('MyAgent');
  
  const ollamaModels = (await getOllamaModels()).filter((m) => {
    const n = m.name || m.model || '';
    return !isExcludedOllamaModel(n);
  });
  
  if (ollamaModels.length === 0) {
    console.log('⚠️  未找到已安装的 Ollama 模型');
    console.log('');
    console.log('你可以运行以下命令安装模型:');
    console.log('  ollama pull qwen3-vl:8b');
    console.log('  ollama pull gemma4:26b');
    return;
  }
  
  console.log(`📦 发现 ${ollamaModels.length} 个已安装的模型:`);
  console.log('');
  
  const modelConfigs = ollamaModels.map(generateModelConfig);
  modelConfigs.forEach((config, index) => {
    console.log(`  ${index + 1}. ${config.name}`);
    console.log(`     模型: ${config.modelName}`);
    console.log('');
  });
  
  console.log('💾 正在配置模型...');
  const allModels = await saveModelsToStore(modelConfigs);
  
  console.log('');
  console.log('✨ 配置完成！');
  console.log('');
  console.log('你可以在应用中:');
  console.log('  1. 点击右上角的模型选择器');
  console.log('  2. 选择任意本地模型开始对话');
  console.log('  3. 在设置面板中查看和管理模型');
  console.log('');
}

main().catch(console.error);
