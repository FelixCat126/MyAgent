/**
 * 必须在其它引用 app.getPath('userData') 的模块 **加载之前** 执行（main 入口第一 import）。
 * 开发态默认可为 Electron/myagent 等，与安装包 MyAgent 的目录不一致，导致像「新装 DMG 丢数据」。
 * 统一与 electron-builder 的 productName 一致。
 */
import { app } from 'electron';
import path from 'path';

const myAgentData = path.join(app.getPath('appData'), 'MyAgent');
if (app.getPath('userData') !== myAgentData) {
  app.setPath('userData', myAgentData);
}

/**
 * 升级安装兼容性约束：版本升级只能更改 package version，不能根据版本号、
 * 构建架构或安装位置改变 userData。这样覆盖安装 1.2.0 时会继续读取同一份
 * ~/Library/Application Support/MyAgent 数据和加密配置。
 */
