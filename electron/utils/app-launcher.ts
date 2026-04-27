import { ipcMain } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);

// 跨平台应用启动器
class AppLauncher {
  // 启动应用
  async launchApp(appName: string): Promise<boolean> {
    try {
      const platform = process.platform;
      let command: string;

      switch (platform) {
        case 'darwin': // macOS
          command = `open -a "${appName}"`;
          break;
        case 'win32': // Windows
          command = `start "" "${appName}"`;
          break;
        case 'linux': // Linux
          command = `${appName} &`;
          break;
        default:
          throw new Error(`不支持的操作系统: ${platform}`);
      }

      await execAsync(command);
      console.log(`已启动应用: ${appName}`);
      return true;
    } catch (error: any) {
      console.error(`启动应用失败: ${appName}`, error.message);
      return false;
    }
  }

  // 获取已安装应用列表（macOS）
  async getMacApps(): Promise<string[]> {
    try {
      const apps: string[] = [];
      
      // 扫描 /Applications 目录
      const appDirs = ['/Applications', '/System/Applications'];
      
      for (const dir of appDirs) {
        try {
          const entries = await fs.readdir(dir);
          for (const entry of entries) {
            if (entry.endsWith('.app')) {
              apps.push(entry.replace('.app', ''));
            }
          }
        } catch (error) {
          // 忽略无法访问的目录
        }
      }
      
      return apps.sort();
    } catch (error) {
      console.error('获取 macOS 应用列表失败:', error);
      return [];
    }
  }

  // 获取已安装应用列表（Windows）
  async getWindowsApps(): Promise<string[]> {
    try {
      // Windows 可以从注册表或开始菜单获取
      // 这里简化处理，返回常用应用
      return [
        'notepad',
        'calc',
        'mspaint',
        'code',
        'chrome',
        'firefox',
        'explorer',
      ];
    } catch (error) {
      console.error('获取 Windows 应用列表失败:', error);
      return [];
    }
  }

  // 获取已安装应用列表（Linux）
  async getLinuxApps(): Promise<string[]> {
    try {
      const apps: string[] = [];
      const desktopDir = '/usr/share/applications';
      
      try {
        const entries = await fs.readdir(desktopDir);
        for (const entry of entries) {
          if (entry.endsWith('.desktop')) {
            const name = entry.replace('.desktop', '');
            apps.push(name);
          }
        }
      } catch (error) {
        // 忽略无法访问的目录
      }
      
      return apps.sort();
    } catch (error) {
      console.error('获取 Linux 应用列表失败:', error);
      return [];
    }
  }

  // 获取已安装应用列表
  async getInstalledApps(): Promise<string[]> {
    const platform = process.platform;
    
    switch (platform) {
      case 'darwin':
        return await this.getMacApps();
      case 'win32':
        return await this.getWindowsApps();
      case 'linux':
        return await this.getLinuxApps();
      default:
        return [];
    }
  }
}

const launcher = new AppLauncher();

// 注册 IPC 处理器
ipcMain.handle('launch-app', async (_event, appName: string) => {
  return await launcher.launchApp(appName);
});

ipcMain.handle('get-installed-apps', async () => {
  return await launcher.getInstalledApps();
});

console.log('✅ 应用启动 IPC 处理器已注册');
