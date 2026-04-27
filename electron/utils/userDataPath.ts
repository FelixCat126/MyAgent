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
