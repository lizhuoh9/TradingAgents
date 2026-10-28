// Run with Playwright available through NODE_PATH; uses only a loopback test server.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { officialRepoPath } = require('./repo-path');

(async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, correctAuth: req.headers.authorization === 'Bearer fake-key-only' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-fetch-e2e-'));
  const desktop = path.join(root, 'TradingAgents-Desktop');
  const repo = path.join(root, 'TradingAgents');
  fs.mkdirSync(desktop); fs.mkdirSync(repo);
  // Keep this unrelated connection/batch fixture offline; update transport has its own tests.
  fs.writeFileSync(path.join(desktop, 'update-service.js'), `module.exports = { recoverUiUpdate() {}, createUpdateService: () => ({ check: async () => ({ checkedAt: null, kernel: { status: 'unknown' }, ui: { status: 'unknown' } }) }) };`);
  for (const name of ['package.json', 'main.js', 'repo-path.js', 'preload.js', 'analysis-control.js', 'batch-runner.js', 'watchlist-store.js', 'holdings-store.js', 'a-share-screener.js', 'job_supervisor.py', 'memory_transaction.py', 'memory_commit.py', 'model_catalog_bridge.py', 'model-service.js', 'latest-queue.js', 'profile-store.js', 'data-key-store.js', 'fred_guard.py', 'report-store.js', 'environment.js', 'validate.js', 'mask.js', 'strip-control.js', 'index.html', 'style.css', 'renderer.js', 'vendor', 'assets']) {
    fs.cpSync(path.join(__dirname, name), path.join(desktop, name), { recursive: true });
  }
  fs.symlinkSync(path.join(officialRepoPath(__dirname), '.venv-win'), path.join(repo, '.venv-win'), 'junction');
  const app = await electron.launch({ executablePath: path.join(__dirname, 'node_modules/electron/dist/electron.exe'), args: [desktop, '--user-data-dir=' + path.join(root, 'user')], env: { ...process.env, TRADINGAGENTS_SOURCE_DIR: repo }, timeout: 30000 });
  try {
    const page = await app.firstWindow();
    await page.click('.navigation [data-page=settings]');
    await page.fill('#profile-name', '模拟连接');
    await page.fill('#profile-url', base);
    await page.fill('#profile-key', 'fake-key-only');
    await page.waitForTimeout(1000);
    assert.equal(requests.length, 0, 'network request before user clicked test');
    await page.click('#model-fetch');
    await page.waitForFunction(() => document.querySelector('#model-fetch-status').textContent.includes('连接成功'), null, { timeout: 30000 });
    assert.deepEqual(requests, [{ path: '/v1/models', correctAuth: true }]);
    await page.selectOption('#profile-model-choice', 'model-b');
    assert.equal(await page.inputValue('#profile-model'), 'model-b');
    await page.click('#save-profile');
    await page.waitForFunction(() => document.querySelector('#settings-message').textContent.includes('已保存'), null, { timeout: 30000 });
    await page.click('.profile-item');
    assert.equal(await page.inputValue('#profile-key'), '');
    await page.click('#model-fetch');
    await page.waitForFunction(() => document.querySelector('#model-fetch-status').textContent.includes('连接成功'), null, { timeout: 30000 });
    assert.deepEqual(requests, [{ path: '/v1/models', correctAuth: true }, { path: '/v1/models', correctAuth: true }]);
    console.log('Electron + loopback: explicit test, live model selection and saved credential reuse passed.');
  } finally {
    await app.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
