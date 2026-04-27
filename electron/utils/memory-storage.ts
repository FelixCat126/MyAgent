import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';

interface ChatSession {
  id: string;
  title: string;
  messages: any[];
  createdAt: number;
  updatedAt: number;
}

// 数据存储目录
const dataDir = path.join(app.getPath('userData'), 'chats');

// 确保数据目录存在
async function ensureDataDir() {
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch (error) {
    console.error('创建数据目录失败:', error);
  }
}

// 获取数据文件路径
function getDataFilePath(sessionId: string): string {
  return path.join(dataDir, `${sessionId}.json`);
}

// 保存对话会话
export async function saveSession(session: ChatSession): Promise<void> {
  try {
    await ensureDataDir();
    const filePath = getDataFilePath(session.id);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
    console.log(`对话已保存: ${session.id}`);
  } catch (error: any) {
    console.error('保存对话失败:', error.message);
    throw error;
  }
}

// 加载对话会话
export async function loadSession(sessionId: string): Promise<ChatSession | null> {
  try {
    const filePath = getDataFilePath(sessionId);
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data) as ChatSession;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return null;
    }
    console.error('加载对话失败:', error.message);
    throw error;
  }
}

// 获取所有对话列表
export async function loadAllSessions(): Promise<ChatSession[]> {
  try {
    await ensureDataDir();
    const files = await fs.readdir(dataDir);
    const sessions: ChatSession[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const sessionId = file.replace('.json', '');
        const session = await loadSession(sessionId);
        if (session) {
          sessions.push(session);
        }
      }
    }

    // 按更新时间排序
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error: any) {
    console.error('加载对话列表失败:', error.message);
    return [];
  }
}

// 删除对话会话
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    const filePath = getDataFilePath(sessionId);
    await fs.unlink(filePath);
    console.log(`对话已删除: ${sessionId}`);
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error('删除对话失败:', error.message);
      throw error;
    }
  }
}

// 导出对话为文本文件
export async function exportSession(session: ChatSession): Promise<string> {
  try {
    const exportDir = path.join(app.getPath('desktop'), 'myagent-exports');
    await fs.mkdir(exportDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${session.title}_${timestamp}.txt`;
    const filePath = path.join(exportDir, fileName);

    let content = `对话: ${session.title}\n`;
    content += `创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}\n`;
    content += `导出时间: ${new Date().toLocaleString('zh-CN')}\n`;
    content += '='.repeat(50) + '\n\n';

    for (const message of session.messages) {
      const role = message.role === 'user' ? '你' : 'AI';
      const time = new Date(message.timestamp).toLocaleString('zh-CN');
      
      content += `[${role}] ${time}\n`;
      content += message.content + '\n\n';

      if (message.files && message.files.length > 0) {
        content += '附件: ' + message.files.map((f: any) => f.name).join(', ') + '\n\n';
      }

      content += '-'.repeat(50) + '\n\n';
    }

    await fs.writeFile(filePath, content, 'utf-8');
    console.log(`对话已导出: ${filePath}`);
    return filePath;
  } catch (error: any) {
    console.error('导出对话失败:', error.message);
    throw error;
  }
}

// 搜索对话内容
export async function searchSessions(query: string): Promise<ChatSession[]> {
  try {
    const sessions = await loadAllSessions();
    const lowerQuery = query.toLowerCase();

    return sessions.filter((session) => {
      // 搜索标题
      if (session.title.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // 搜索消息内容
      return session.messages.some((msg: any) =>
        msg.content.toLowerCase().includes(lowerQuery)
      );
    });
  } catch (error: any) {
    console.error('搜索对话失败:', error.message);
    return [];
  }
}

console.log('✅ 对话记忆模块已加载');

