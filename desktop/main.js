const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require('electron');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validate } = require('./validate');
const { createMask } = require('./mask');
const { createControlStripper } = require('./strip-control');
const { createProfileStore, validProfile } = require('./profile-store');
const { createDataKeyStore } = require('./data-key-store');
const { createReportStore } = require('./report-store');
const { cleanEnvironment } = require('./environment');
const { createAnalysisControl } = require('./analysis-control');
const { createLatestQueue } = require('./latest-queue');
const { credentialForRequest, fetchAvailableModels } = require('./model-service');
const { createWatchlistStore, normalizeWatchItem, MAX_WATCHLIST } = require('./watchlist-store');
const { createBatchRunner } = require('./batch-runner');
const { createAShareScreener } = require('./a-share-screener');
const { createUpdateService, recoverUiUpdate } = require('./update-service');

const { officialRepoPath } = require('./repo-path');
const repo = officialRepoPath(__dirname);
const python = path.join(repo, '.venv-win', 'Scripts', 'python.exe');
const stateDir = path.join(__dirname, 'local-data', 'analysis');
const reports = path.join(stateDir, 'logs');
const updateMarker = path.join(__dirname, 'update-incomplete');
let running = false;
const analysisControl = createAnalysisControl();
const modelCatalogQueue = createLatestQueue(({ provider, baseUrl }) => new Promise((resolve, reject) => {
  const child = execFile(python, [path.join(__dirname, 'model_catalog_bridge.py')], { cwd: repo, env: cleanEnvironment(process.env), windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error) { reject(new Error('无法读取本地模型目录，可以手动输入模型名称')); return; }
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('本地模型目录格式无效，可以手动输入模型名称')); }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ provider, baseUrl }));
}));

function command(win, exe, args, env, secret = '', onStart = () => {}, onError = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: repo, env, windowsHide: true });
    onStart(child);
    const mask = createMask(secret);
    const emit = text => { if (text && !win.isDestroyed()) win.webContents.send('log', text); };
    const output = stream => {
      const decoder = new StringDecoder('utf8');
      const strip = createControlStripper();
      const send = text => emit(mask(strip(text)));
      stream.on('data', chunk => send(decoder.write(chunk)));
      stream.on('end', () => send(decoder.end()));
    };
    output(child.stdout);
    output(child.stderr);
    child.on('error', error => {
      if (child.pid == null) reject(error);
      else { emit('\n无法向任务发送停止信号，请等待任务结束或重试。\n'); onError(); }
    });
    child.on('close', code => { emit(mask('', true)); resolve(code); });
  });
}

function supervisorPython() {
  const config = fs.readFileSync(path.join(repo, '.venv-win', 'pyvenv.cfg'), 'utf8');
  const match = config.match(/^executable\s*=\s*(.+?)\s*$/im);
  const executable = match?.[1];
  if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('无法找到安全停止所需的基础 Python，请修复本地运行环境');
  return executable;
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else app.whenReady().then(() => {
  try { recoverUiUpdate(__dirname); }
  catch (error) { dialog.showErrorBox('界面更新恢复失败', error.message + '\n请保留本地备份并修复安装后再启动。'); app.quit(); return; }
  const updates = createUpdateService({ desktopDir: __dirname, repo, hostVersion: require('./package.json').version });
  const profiles = createProfileStore(path.join(__dirname, 'local-data', 'api-profiles.bin'), safeStorage);
  const fred = createDataKeyStore(path.join(__dirname, 'local-data', 'fred-key.bin'), safeStorage);
  const watchlist = createWatchlistStore(path.join(__dirname, 'local-data', 'watchlist.json'));
  const screener = createAShareScreener({ cacheFile: path.join(__dirname, 'local-data', 'a-share-cache.json') });
  let screening = null;
  const reportStore = createReportStore(reports);
  const win = new BrowserWindow({ width: 1050, height: 800, minWidth: 780, minHeight: 620,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.on('close', event => {
    if (running) { event.preventDefault(); win.webContents.send('log', '\n任务仍在运行，请等待完成后关闭窗口。\n'); }
  });
  win.loadFile('index.html');
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  async function runOneAnalysis(input, profile, fredKey) {
      const env = cleanEnvironment(process.env);
      const now = new Date();
      const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('') + '-' + [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
      const runDir = path.join(reports, input.date, input.ticker.toUpperCase(), `run-${stamp}-${crypto.randomUUID().slice(0, 8)}`);
      fs.mkdirSync(runDir, { recursive: true });
      const incompleteMarker = path.join(runDir, '.run-incomplete');
      fs.writeFileSync(incompleteMarker, 'Run has not completed successfully.\n', { flag: 'wx' });
      Object.assign(env, { TRADING_DESKTOP_API_KEY: profile.key, TRADING_DESKTOP_STATE_DIR: stateDir, PYTHONUTF8: '1', PYTHON_DOTENV_DISABLED: '1',
        TRADINGAGENTS_LLM_PROVIDER: profile.provider, TRADINGAGENTS_QUICK_THINK_LLM: profile.model,
        TRADINGAGENTS_DEEP_THINK_LLM: profile.model, TRADINGAGENTS_OUTPUT_LANGUAGE: 'Chinese',
        TRADINGAGENTS_MAX_DEBATE_ROUNDS: '1', TRADINGAGENTS_MAX_RISK_ROUNDS: '1',
        TRADINGAGENTS_RESULTS_DIR: runDir, TRADINGAGENTS_CACHE_DIR: path.join(stateDir, 'cache'),
        TRADINGAGENTS_MEMORY_LOG_PATH: path.join(stateDir, 'memory', 'trading_memory.md'), TRADINGAGENTS_NO_UPDATE_CHECK: '1' });
      if (fredKey) env.TRADING_DESKTOP_FRED_API_KEY = fredKey;
      if (profile.baseUrl) env.TRADINGAGENTS_LLM_BACKEND_URL = profile.baseUrl;
      let task;
      let code = await command(win, supervisorPython(), [path.join(__dirname, 'job_supervisor.py'), python, path.join(__dirname, 'run_analysis.py'), input.ticker.toUpperCase(), input.date], env, [profile.key, fredKey], child => { task = analysisControl.attach(child); }, () => { if (!win.isDestroyed()) win.webContents.send('stop-error', '无法停止任务，请重试或等待任务结束。'); });
      const stopped = task.stopRequested && task.closeSignal === 'SIGTERM';
      let reportId = null;
      if (code === 0 && !stopped) {
        let found = null;
        try { found = reportStore.list({ includeIncomplete: true }).find(item => item.id.startsWith(path.relative(reports, runDir) + path.sep)); }
        catch { win.webContents.send('log', '\n无法读取报告目录，请检查文件权限。\n'); }
        if (found) {
          try {
            const commitCode = await command(win, python, [path.join(__dirname, 'memory_commit.py'), env.TRADINGAGENTS_MEMORY_LOG_PATH, path.join(runDir, 'memory', 'trading_memory.md')], cleanEnvironment(process.env));
            if (commitCode === 0) { fs.unlinkSync(incompleteMarker); reportId = found.id; }
            else { code = commitCode || 1; win.webContents.send('log', '\n历史记录未能安全提交，本次文件已保留。\n'); }
          } catch { code = 1; win.webContents.send('log', '\n无法启动历史记录提交，本次文件已保留。\n'); }
        }
      }
      return { code, reportId, stopped };
  }
  let batchRunner = null;
  ipcMain.handle('run', async (_event, input) => {
    if (running) throw new Error('已有任务正在运行');
    recoverUiUpdate(__dirname);
    if (fs.existsSync(updateMarker)) throw new Error('上次内核更新未完成，请打开“更新”并重试官方内核更新');
    validate(input);
    const profile = profiles.get(input.profileId);
    const fredKey = fred.get();
    running = true;
    try { return await runOneAnalysis(input, profile, fredKey); }
    finally { running = false; }
  });
  ipcMain.handle('run-batch', async (_event, input) => {
    if (running) throw new Error('已有任务正在运行');
    recoverUiUpdate(__dirname);
    if (fs.existsSync(updateMarker)) throw new Error('上次内核更新未完成，请打开“更新”并重试官方内核更新');
    if (!input || !Array.isArray(input.tickers) || !input.tickers.length || input.tickers.length > MAX_WATCHLIST) throw new Error('请选择需要分析的自选股票');
    const tickers = input.tickers.map(ticker => normalizeWatchItem({ ticker }).ticker);
    if (new Set(tickers).size !== tickers.length) throw new Error('批量列表中包含重复股票');
    for (const ticker of tickers) validate({ ticker, date: input.date });
    const profile = profiles.get(input.profileId);
    const fredKey = fred.get();
    running = true;
    batchRunner = createBatchRunner({
      runOne: async ticker => {
        try { return await runOneAnalysis({ ticker, date: input.date, profileId: input.profileId }, profile, fredKey); }
        catch (error) {
          const strip = createControlStripper();
          const mask = createMask([profile.key, fredKey]);
          const detail = mask(strip(String(error?.message || '无法启动或保存分析')), true).slice(0, 1000);
          if (!win.isDestroyed()) win.webContents.send('log', `\n${ticker} 分析出错：${detail}\n`);
          throw error;
        }
      },
      stopActive: () => analysisControl.stop(),
      notify: progress => {
        if (win.isDestroyed()) return;
        if (progress.status === 'running') win.webContents.send('log', `\n──── ${progress.ticker} · 开始分析 ────\n`);
        if (progress.status === 'failed') win.webContents.send('log', `\n${progress.ticker} 分析未完成，请查看上方日志。\n`);
        win.webContents.send('batch-progress', { ...progress, date: input.date });
      },
    });
    try { return await batchRunner.start(tickers); }
    finally { batchRunner = null; running = false; }
  });
  ipcMain.handle('stop', () => batchRunner?.isActive() ? batchRunner.stop() : analysisControl.stop());
  ipcMain.handle('watchlist', () => watchlist.initialize(() => reportStore.list()));
  ipcMain.handle('watchlist-add', (_event, input) => {
    const item = normalizeWatchItem(input);
    watchlist.initialize(() => reportStore.list());
    return watchlist.add(item);
  });
  ipcMain.handle('watchlist-remove', (_event, ticker) => {
    const item = normalizeWatchItem({ ticker });
    watchlist.initialize(() => reportStore.list());
    return watchlist.remove(item.ticker);
  });
  ipcMain.handle('screen-a-shares', () => {
    if (!screening) screening = screener.screen().finally(() => { screening = null; });
    return screening;
  });
  ipcMain.handle('updates-check', (_event, force = false) => {
    if (typeof force !== 'boolean') throw new Error('检查更新参数无效');
    return updates.check({ force });
  });
  ipcMain.handle('ui-reload', () => {
    if (running || modelCatalogQueue.isBusy()) throw new Error('任务进行中，请完成后重新加载界面');
    recoverUiUpdate(__dirname);
    win.webContents.reload();
  });
  ipcMain.handle('update', async (_event, target) => {
    if (!['kernel', 'ui'].includes(target)) throw new Error('请选择官方内核或界面更新');
    if (running) throw new Error('分析或更新正在运行');
    if (modelCatalogQueue.isBusy()) throw new Error('模型目录读取中，请稍后更新');
    running = true;
    try {
      if (target === 'ui') return await updates.installUi();
      const env = { ...cleanEnvironment(process.env), GIT_TERMINAL_PROMPT: '0' };
      const gitValue = args => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', windowsHide: true }).trim();
      if (gitValue(['remote', 'get-url', 'origin']) !== 'https://github.com/TauricResearch/TradingAgents.git' || gitValue(['branch', '--show-current']) !== 'main') {
        throw new Error('官方仓库地址或当前分支已改变，已停止更新');
      }
      // Git refuses to overwrite conflicting untracked files; tracked changes block updates.
      if (await command(win, 'git', ['diff', '--quiet'], env) !== 0 || await command(win, 'git', ['diff', '--cached', '--quiet'], env) !== 0) throw new Error('官方源码有本地修改，已停止更新');
      fs.writeFileSync(updateMarker, 'Update interrupted or incomplete. Retry the update before running analyses.\n');
      if (await command(win, 'git', ['pull', '--ff-only', 'origin', 'main'], env) !== 0) throw new Error('更新源码失败，请查看日志并重试');
      if (await command(win, python, ['-m', 'pip', 'install', '-e', '.'], env) !== 0) throw new Error('源码已更新，但依赖安装失败；请检查网络并重新点击更新，成功前不要运行分析');
      fs.unlinkSync(updateMarker);
      return '官方内核更新完成';
    } finally { running = false; }
  });
  ipcMain.handle('reports', () => { fs.mkdirSync(reports, { recursive: true }); return shell.openPath(reports); });
  ipcMain.handle('profiles', () => profiles.list());
  ipcMain.handle('fred-status', () => fred.status());
  ipcMain.handle('fred-save', (_event, key) => { if (running) throw new Error('任务正在运行，请稍后保存'); return fred.put(key); });
  ipcMain.handle('fred-delete', () => { if (running) throw new Error('任务正在运行，请稍后操作'); return fred.remove(); });
  ipcMain.handle('fred-backup-unreadable', () => { if (running) throw new Error('任务正在运行，请稍后操作'); return fred.backupUnreadable(); });
  ipcMain.handle('model-catalog', (_event, input) => {
    const provider = String(input?.provider || '').trim().toLowerCase();
    const baseUrl = String(input?.baseUrl || '').trim();
    if (!/^[a-z0-9_-]{1,40}$/.test(provider) || baseUrl.length > 500) throw new Error('服务类型或地址格式不正确');
    if (running) throw new Error('分析或更新进行中，请稍后读取模型目录');
    return modelCatalogQueue.submit({ provider, baseUrl });
  });
  ipcMain.handle('models-fetch', async (_event, input) => {
    const provider = String(input?.provider || '').trim().toLowerCase();
    const baseUrl = String(input?.baseUrl || '').trim();
    if (!/^[a-z0-9_-]{1,40}$/.test(provider) || baseUrl.length > 500) throw new Error('服务类型或地址格式不正确');
    const key = credentialForRequest({ provider, baseUrl, key: input?.key, profileId: input?.profileId }, profiles);
    let endpoint = baseUrl;
    if (provider !== 'openai_compatible') {
      if (running) throw new Error('分析或更新进行中，请稍后测试连接');
      const catalog = await modelCatalogQueue.submit({ provider, baseUrl });
      if (catalog.superseded) throw new Error('配置已变更，请重新测试连接');
      endpoint = catalog.compatibleBaseUrl;
      if (!endpoint) throw new Error('此服务类型暂不支持自动获取模型，请手动填写模型 ID');
    }
    if (!endpoint) throw new Error('请先填写 API 地址');
    return fetchAvailableModels(endpoint, key);
  });
  ipcMain.handle('profile-save', async (_event, input) => {
    if (running) throw new Error('任务正在运行，请稍后保存');
    const { provider } = validProfile(input);
    running = true;
    try {
      await new Promise((resolve, reject) => execFile(python, ['-c', 'import sys; from tradingagents.llm_clients.api_key_env import PROVIDER_API_KEY_ENV; sys.exit(0 if sys.argv[1] in PROVIDER_API_KEY_ENV else 1)', provider], { cwd: repo, env: cleanEnvironment(process.env), windowsHide: true }, error => error ? reject(new Error('供应商代码无法验证，请检查代码和官方项目安装')) : resolve()));
      return profiles.put(input);
    } finally { running = false; }
  });
  ipcMain.handle('profile-select', (_event, id) => profiles.select(id));
  ipcMain.handle('profile-delete', (_event, id) => profiles.delete(id));
  ipcMain.handle('profile-backup-unreadable', () => {
    if (running) throw new Error('任务正在运行，请稍后操作');
    return profiles.backupUnreadable();
  });
  ipcMain.handle('reports-list', () => reportStore.list());
  ipcMain.handle('report-read', (_event, id) => reportStore.read(id));
});
app.on('window-all-closed', () => app.quit());
