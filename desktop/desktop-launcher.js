// Stable entry point: acquire the lock and recover before loading updateable code.
const { app, dialog } = require('electron');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let recovered;
  try { recovered = require('./desktop-update').recoverDesktopUpdate(__dirname); }
  catch (error) {
    dialog.showErrorBox('桌面更新恢复失败', `${error.message}\n请保留本地备份并修复安装。`);
    app.exit(1);
    throw error;
  }
  if (recovered) { app.relaunch(); app.exit(0); }
  else if (require('node:fs').existsSync(require('node:path').join(__dirname, 'local-data', 'ui-update-pending.json'))) {
    dialog.showErrorBox('旧版界面更新未完成', '请保留本地数据，先使用原版本完成界面恢复，再升级桌面程序。');
    app.exit(1);
  } else require('./main');
}
