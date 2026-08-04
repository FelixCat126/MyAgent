/**
 * 强制让 macOS 「隐私 → 摄像头」出现 Electron，并弹出系统授权框。
 *
 * 必须用系统「终端.app」运行（不要用 ZCode 内置终端），否则弹窗常被吞掉、列表也不登记：
 *   npm run grant:camera
 */
const { app, systemPreferences, dialog, shell } = require('electron');

app.whenReady().then(async () => {
  const before = systemPreferences.getMediaAccessStatus('camera');
  process.stdout.write(`[grant:camera] before=${before}\n`);

  const granted = await systemPreferences.askForMediaAccess('camera');
  const after = systemPreferences.getMediaAccessStatus('camera');
  process.stdout.write(`[grant:camera] ask=${granted} after=${after}\n`);

  if (granted || after === 'granted') {
    dialog.showMessageBoxSync({
      type: 'info',
      title: '摄像头授权',
      message: '已授权给 Electron',
      detail: '请回到 MyAgent，重新打开「手势/视觉识别」即可。',
    });
    app.quit();
    return;
  }

  try {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    );
  } catch {
    /* ignore */
  }

  dialog.showMessageBoxSync({
    type: 'warning',
    title: '摄像头授权',
    message: '系统未授予摄像头权限',
    detail:
      '已打开「系统设置 → 隐私与安全性 → 摄像头」。\n' +
      '请勾选列表中的「Electron」（不是 ZCode）。\n' +
      '若仍没有 Electron：先点「允许」弹窗，或重启后再运行一次 npm run grant:camera。',
  });
  app.quit();
});
