import { ipcMain, app } from 'electron';
import fs from 'fs/promises';
import path from 'path';

/** 使用 userData，避免放在 /var/.../T 下被系统清掉导致会话里图片 404 */
function getUploadDir(): string {
  return path.join(app.getPath('userData'), 'myagent-uploads');
}

async function ensureUploadDir() {
  try {
    await fs.mkdir(getUploadDir(), { recursive: true });
  } catch (error) {
    console.error('创建上传目录失败:', error);
  }
}

// 处理文件上传
ipcMain.handle('upload-file', async (_event, fileData: {
  name: string;
  buffer: number[];
  type: string;
  size: number;
}) => {
  try {
    await ensureUploadDir();
    
    const timestamp = Date.now();
    const fileName = `${timestamp}-${fileData.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const filePath = path.join(getUploadDir(), fileName);
    
    // 将 buffer 转换为 Buffer 并写入文件
    const buffer = Buffer.from(fileData.buffer);
    await fs.writeFile(filePath, buffer);
    
    // smaller-images (<512KB) preview generation
    let preview: string | undefined;
    if (fileData.type.startsWith('image/') && fileData.size < 512000) {
      try {
        const base64 = `data:${fileData.type};base64,${buffer.toString('base64')}`;
        preview = base64;
      } catch {
        console.warn('Failed to generate preview for image', fileData.name);
      }
    }

    console.log(`文件已保存: ${filePath}, 预览已${preview ? '生成' : '跳过'} (size=${fileData.size}, type=${fileData.type})`);
    
    return {
      path: filePath,
      name: fileData.name,
      type: fileData.type,
      size: fileData.size,
      preview,
    };
  } catch (error: any) {
    console.error('文件上传失败:', error.message);
    throw new Error(error.message);
  }
});

// 清理本应用上传目录（含持久化附件；仅应在用户明确「清缓存」等场景调用）
ipcMain.handle('cleanup-uploads', async () => {
  try {
    await fs.rm(getUploadDir(), { recursive: true, force: true });
    console.log('上传目录已清理');
  } catch (error: any) {
    console.error('清理上传目录失败:', error.message);
  }
});

console.log('✅ 文件处理 IPC 处理器已注册');