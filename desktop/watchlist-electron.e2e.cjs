// Isolated Electron exercise. The copied supervisor and profile are fake;
// no actual user data, market service, or model provider is used.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-watchlist-electron-'));
  const desktop = path.join(root, 'TradingAgents-Desktop');
  const repo = path.join(root, 'TradingAgents');
  fs.mkdirSync(desktop); fs.mkdirSync(repo);
  // Keep this unrelated connection/batch fixture offline; update transport has its own tests.
  fs.writeFileSync(path.join(desktop, 'update-service.js'), `module.exports = { recoverUiUpdate() {}, createUpdateService: () => ({ check: async () => ({ checkedAt: null, kernel: { status: 'unknown' }, ui: { status: 'unknown' } }) }) };`);
  for (const name of ['package.json', 'main.js', 'preload.js', 'analysis-control.js', 'batch-runner.js', 'watchlist-store.js', 'a-share-screener.js', 'memory_transaction.py', 'model_catalog_bridge.py', 'model-service.js', 'latest-queue.js', 'profile-store.js', 'data-key-store.js', 'fred_guard.py', 'report-store.js', 'environment.js', 'validate.js', 'mask.js', 'strip-control.js', 'index.html', 'style.css', 'renderer.js', 'vendor', 'assets']) {
    fs.cpSync(path.join(__dirname, name), path.join(desktop, name), { recursive: true });
  }
  const locatorFile = path.join(__dirname, 'repo-path.js');
  const installedRepo = fs.existsSync(locatorFile) ? require(locatorFile).officialRepoPath(__dirname) : path.resolve(__dirname, '../TradingAgents');
  if (fs.existsSync(locatorFile)) fs.copyFileSync(locatorFile, path.join(desktop, 'repo-path.js'));
  const desktopData = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8').includes("path.join(__dirname, 'local-data', 'analysis')");
  const stateDir = desktopData ? path.join(desktop, 'local-data', 'analysis') : path.join(repo, 'local-data');
  // The interpreter and installed package are read-only. All application state,
  // reports, profiles, and fake child-process output remain under root.
  fs.symlinkSync(path.join(installedRepo, '.venv-win'), path.join(repo, '.venv-win'), 'junction');
  fs.writeFileSync(path.join(desktop, 'job_supervisor.py'), `import os, sys, time
from pathlib import Path
ticker = sys.argv[3]
state = Path(os.environ['TRADING_DESKTOP_STATE_DIR'])
state.mkdir(parents=True, exist_ok=True)
with (state / 'test-started.txt').open('a', encoding='utf-8') as out:
    out.write(ticker + '\\n')
    out.flush()
if ticker == 'AAPL':
    target = Path(os.environ['TRADINGAGENTS_RESULTS_DIR']) / 'reports' / 'fake'
    target.mkdir(parents=True, exist_ok=True)
    (target / 'complete_report.md').write_text('# Trading Analysis Report: AAPL\\n\\n- Rating: Hold\\n\\n## V. Portfolio Manager Decision\\n\\n### Portfolio Manager\\n**Rating**: Hold\\n', encoding='utf-8')
    time.sleep(0.3)
else:
    time.sleep(120)
`);
  fs.writeFileSync(path.join(desktop, 'memory_commit.py'), 'import sys\nsys.exit(0)\n');
  const executablePath = path.join(__dirname, 'node_modules/electron/dist/electron.exe');
  const userData = path.join(root, 'electron-user-data');
  const launch = () => electron.launch({ executablePath, args: [desktop, '--user-data-dir=' + userData], env: { ...process.env, TRADINGAGENTS_SOURCE_DIR: repo }, timeout: 30000 });
  let app;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await page.click('.navigation [data-page=settings]');
    await page.fill('#profile-name', 'Fake model');
    await page.fill('#profile-url', 'http://127.0.0.1:1/v1');
    await page.fill('#profile-model', 'test-model');
    await page.fill('#profile-key', 'fictional-key-only');
    await page.click('#save-profile');
    await page.waitForFunction(() => document.querySelector('#settings-message').textContent.includes('连接已保存'), null, { timeout: 30000 });
    await page.click('.navigation [data-page=watchlist]');
    for (const ticker of ['AAPL', 'MSFT', 'GOOG']) {
      await page.fill('#watch-ticker', ticker);
      await page.click('#watch-add-form button');
      await page.waitForFunction(value => Array.from(document.querySelectorAll('.watch-identity span')).some(item => item.textContent === value), ticker);
    }
    await page.evaluate(() => { window.__batchEvents = []; window.desktop.onBatchProgress(event => window.__batchEvents.push(event)); });
    await page.click('#watch-run');
    await page.waitForFunction(() => window.__batchEvents.some(e => e.ticker === 'AAPL' && e.status === 'completed') && window.__batchEvents.some(e => e.ticker === 'MSFT' && e.status === 'running'), null, { timeout: 30000 });
    const startedFile = path.join(stateDir, 'test-started.txt');
    await page.waitForFunction(() => document.querySelector('#watch-stop') && !document.querySelector('#watch-stop').hidden);
    // The fake child creates this marker before sleeping; wait for it before stopping.
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        if (fs.existsSync(startedFile) && fs.readFileSync(startedFile, 'utf8').replace(/\r\n/g, '\n').includes('MSFT\n')) return resolve();
        if (Date.now() > deadline) return reject(new Error('fake second job did not start'));
        setTimeout(check, 50);
      }; check();
    });
    assert.deepEqual(fs.readFileSync(startedFile, 'utf8').trim().split(/\r?\n/), ['AAPL', 'MSFT']);
    await page.click('#watch-stop');
    await page.waitForFunction(() => document.querySelector('#watch-message').textContent.includes('批次已停止'), null, { timeout: 30000 });
    const events = await page.evaluate(() => window.__batchEvents);
    assert.equal(events.find(e => e.ticker === 'AAPL' && e.status === 'completed').date, await page.inputValue('#watch-date'));
    assert.ok(events.some(e => e.ticker === 'AAPL' && e.status === 'completed' && e.reportId));
    assert.ok(events.some(e => e.ticker === 'MSFT' && e.status === 'stopped'));
    assert.ok(events.some(e => e.ticker === 'GOOG' && e.status === 'cancelled'));
    assert.deepEqual(fs.readFileSync(startedFile, 'utf8').trim().split(/\r?\n/), ['AAPL', 'MSFT']);
    const saved = JSON.parse(fs.readFileSync(path.join(desktop, 'local-data', 'watchlist.json'), 'utf8'));
    assert.deepEqual(saved.map(row => row.ticker), ['AAPL', 'MSFT', 'GOOG']);
    await app.close(); app = null;
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.click('.navigation [data-page=watchlist]');
    await reopened.waitForFunction(() => document.querySelectorAll('.watch-item').length === 3);
    await reopened.waitForFunction(() => document.querySelector('.watch-item').textContent.includes('持有 / 观望'));
    console.log('Isolated Electron: watchlist persisted, first report retained, serial next task stopped and remaining task cancelled.');
  } finally {
    if (app) {
      try {
        const page = await app.firstWindow();
        await page.evaluate(() => window.desktop.stop());
        await page.waitForFunction(() => document.querySelector('#watch-stop').hidden, null, { timeout: 10000 });
      } catch { /* The window may already be closed or the test never started a batch. */ }
      await app.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
