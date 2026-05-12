import { ipcMain, app } from 'electron';
import fs from 'fs/promises';
import path from 'path';

/** 使用 userData，避免放在 /var/.../T 下被系统清掉导致会话里图片 404 */
export function getUploadDir(): string {
  return path.join(app.getPath('userData'), 'myagent-uploads');
}

/** 远端网关等：与 upload-file IPC 相同落盘逻辑 */
export async function writeUploadBufferToUserData(payload: {
  name: string;
  buffer: Buffer;
  type: string;
  size: number;
}): Promise<{
  path: string;
  name: string;
  type: string;
  size: number;
  preview?: string;
}> {
  await fs.mkdir(getUploadDir(), { recursive: true }).catch(() => undefined);
  const timestamp = Date.now();
  const fileName = `${timestamp}-${payload.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const filePath = path.join(getUploadDir(), fileName);
  await fs.writeFile(filePath, payload.buffer);
  let preview: string | undefined;
  if (payload.type.startsWith('image/') && payload.size < 512000) {
    try {
      preview = `data:${payload.type};base64,${payload.buffer.toString('base64')}`;
    } catch {
      /* ignore */
    }
  }
  console.log(`文件已保存: ${filePath}, 预览已${preview ? '生成' : '跳过'} (size=${payload.size}, type=${payload.type})`);
  return {
    path: filePath,
    name: payload.name,
    type: payload.type,
    size: payload.size,
    ...(preview ? { preview } : {}),
  };
}

// 处理文件上传
ipcMain.handle('upload-file', async (_event, fileData: {
  name: string;
  buffer: number[];
  type: string;
  size: number;
}) => {
  try {
    const buffer = Buffer.from(fileData.buffer);
    return await writeUploadBufferToUserData({
      name: fileData.name,
      buffer,
      type: fileData.type,
      size: fileData.size,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('文件上传失败:', msg);
    throw new Error(msg);
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