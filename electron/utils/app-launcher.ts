import { ipcMain } from 'electron';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execFileAsync = promisify(execFile);

/** 应用名来自模型输出：只允许字母/数字/空格与少量标点，杜绝 shell 元字符、路径与选项注入 */
const APP_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._+()-]{0,127}$/u;

export function isSafeAppName(appName: unknown): appName is string {
  return typeof appName === 'string' && APP_NAME_RE.test(appName);
}

export type LaunchCommand = {
  file: string;
  args: string[];
  /** Linux 直接拉起可执行文件，需脱离父进程 */
  detached?: boolean;
  windowsVerbatimArguments?: boolean;
};

/** 构造不经 shell 的启动命令；名称不合法时返回 null */
export function buildLaunchCommand(platform: NodeJS.Platform, appName: string): LaunchCommand | null {
  const name = String(appName ?? '').trim();
  if (!isSafeAppName(name)) return null;
  switch (platform) {
    case 'darwin':
      return { file: 'open', args: ['-a', name] };
    case 'win32':
      /** start 是 cmd 内建命令；名称已排除引号与 & | < > ^ % 等元字符，可安全置于引号内 */
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${name}"`], windowsVerbatimArguments: true };
    case 'linux':
      return { file: name, args: [], detached: true };
    default:
      return null;
  }
}

// 跨平台应用启动器
class AppLauncher {
  // 启动应用
  async launchApp(appName: string): Promise<boolean> {
    try {
      const platform = process.platform;
      const command = buildLaunchCommand(platform, appName);
      if (!command) throw new Error('应用名称不合法');
      if (platform === 'linux') {
        /** Linux 无 open -a 等价物：仅允许 /usr/share/applications 中登记的应用 */
        if (!(await this.getLinuxApps()).includes(command.file)) throw new Error('应用未安装或不在允许列表中');
        await new Promise<void>((resolve, reject) => {
          const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' });
          child.once('error', reject);
          child.once('spawn', () => {
            child.unref();
            resolve();
          });
        });
      } else {
        await execFileAsync(command.file, command.args, {
          windowsVerbatimArguments: command.windowsVerbatimArguments,
        });
      }
      console.log(`已启动应用: ${appName}`);
      return true;
    } catch (error: unknown) {
      console.error(`启动应用失败: ${appName}`, error instanceof Error ? error.message : String(error));
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
