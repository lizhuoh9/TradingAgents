// Isolated Electron integration: pinned GitHub responses are simulated.
// Set REAL_DESKTOP_RELAUNCH=1 to exercise Electron's actual app.relaunch().
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fileHash } = require('./desktop-update');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-update-electron-'));
  const desktop = path.join(root, 'desktop'); const remote = path.join(root, 'mock-remote');
  const repo = path.join(root, 'fake-official'); const userData = path.join(root, 'electron-user');
  fs.mkdirSync(desktop); fs.mkdirSync(remote); fs.mkdirSync(repo);
  const installed = JSON.parse(fs.readFileSync(path.join(__dirname, 'desktop-release.json'), 'utf8'));
  const version = installed.version.split('.').map(Number); version[2]++;
  const nextVersion = version.join('.');
  for (const [name, digest] of Object.entries(installed.files)) {
    const src = path.join(__dirname, name);
    assert.equal(fileHash(name, fs.readFileSync(src)), digest, `release manifest is stale: ${name}`);
    for (const dir of [desktop, remote]) {
      const target = path.join(dir, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(src, target);
    }
  }
  fs.copyFileSync(path.join(__dirname, 'desktop-release.json'), path.join(desktop, 'desktop-release.json'));
  const read = name => fs.readFileSync(path.join(remote, name));
  const write = (name, value) => fs.writeFileSync(path.join(remote, name), value);
  const pkg = JSON.parse(read('package.json')); pkg.version = nextVersion; write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  const lock = JSON.parse(read('package-lock.json')); lock.version = nextVersion; lock.packages[''].version = nextVersion; write('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  const changedMain = read('main.js').toString('utf8') + '\n// Integration-test future main version.\n'; write('main.js', changedMain);
  const index = read('index.html').toString('utf8').replace('从一个标的，开始研究', '更新后的测试桌面');
  assert.match(index, /更新后的测试桌面/); write('index.html', index);
  const ui = JSON.parse(read('ui-release.json')); ui.files['index.html'] = fileHash('index.html', Buffer.from(index));
  write('ui-release.json', JSON.stringify(ui, null, 2) + '\n');
  const next = { schema: 1, version: nextVersion, files: Object.fromEntries(Object.keys(installed.files).map(name => [name, fileHash(name, read(name))])) };
  write('desktop-release.json', JSON.stringify(next));
  fs.mkdirSync(path.join(desktop, 'local-data'));
  const holdings = JSON.stringify([{ ticker: '600172.SS', name: '测试持仓' }]);
  fs.writeFileSync(path.join(desktop, 'local-data', 'holdings.json'), holdings);
  const relaunchMarker = path.join(root, 'relaunch-requested');
  const startupLog = path.join(root, 'processes.jsonl');
  const restartEvidence = path.join(root, 'restarted.json');
  const realRelaunch = process.env.REAL_DESKTOP_RELAUNCH === '1';
  const wrapper = path.join(desktop, 'mock-launcher.cjs');
  const commit = 'a'.repeat(40);
  fs.writeFileSync(wrapper, `
    const fs = require('node:fs'); const path = require('node:path');
    const { app } = require('electron');
    const installedVersion = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(desktop, 'desktop-release.json'))}, 'utf8')).version;
    fs.appendFileSync(${JSON.stringify(startupLog)}, JSON.stringify({ pid: process.pid, version: installedVersion }) + '\\n');
    if (!${JSON.stringify(realRelaunch)}) app.relaunch = () => fs.writeFileSync(${JSON.stringify(relaunchMarker)}, 'requested');
    if (${JSON.stringify(realRelaunch)} && installedVersion === ${JSON.stringify(nextVersion)}) {
      const watchdog = setTimeout(() => app.exit(1), 20000);
      const evidencePath = ${JSON.stringify(restartEvidence)};
      const writeEvidence = result => { fs.writeFileSync(evidencePath + '.tmp', JSON.stringify(result)); fs.renameSync(evidencePath + '.tmp', evidencePath); };
      app.on('browser-window-created', (_event, win) => {
        win.webContents.once('did-finish-load', async () => {
          try {
            const result = await win.webContents.executeJavaScript('(async () => ({ title: document.querySelector("#analysis-title").textContent, holdings: await window.desktop.holdings() }))()');
            writeEvidence({ pid: process.pid, version: installedVersion, ...result });
          } catch (error) { writeEvidence({ pid: process.pid, error: error.message }); }
          finally { clearTimeout(watchdog); app.quit(); }
        });
      });
    }
    global.fetch = async url => {
      if (url === 'https://api.github.com/repos/lizhuoh9/TradingAgents/commits?path=desktop/desktop-release.json&sha=main&per_page=1') return new Response(JSON.stringify([{ sha: '${commit}' }]));
      const prefix = 'https://raw.githubusercontent.com/lizhuoh9/TradingAgents/${commit}/desktop/';
      if (url.startsWith(prefix)) {
        const relative = url.slice(prefix.length);
        if (!/^(?:[a-z0-9_.-]+|启动桌面版\\.cmd|assets\\/[a-z0-9_.-]+|vendor\\/[a-zA-Z0-9_.-]+)$/.test(relative)) throw new Error('unexpected mock path');
        return new Response(fs.readFileSync(path.join(${JSON.stringify(remote)}, relative)));
      }
      throw new Error('unexpected network request');
    };
    require(${JSON.stringify(path.join(desktop, 'desktop-launcher.js'))});
  `);
  const launch = () => electron.launch({ executablePath: path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [wrapper, '--user-data-dir=' + userData], cwd: desktop, env: { ...process.env, TRADINGAGENTS_SOURCE_DIR: repo }, timeout: 30000 });
  let app;
  const until = async (condition, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (!condition()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for isolated Electron restart or exit'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const processExists = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  try {
    app = await launch();
    const page = await app.firstWindow();
    await page.click('#update');
    await page.waitForFunction(version => document.querySelector('#ui-update-latest').textContent === version, nextVersion, { timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('#update-ui').disabled);
    const closed = app.waitForEvent('close', { timeout: 30000 });
    await page.click('#update-ui');
    await closed; app = null;
    if (!realRelaunch) assert.equal(fs.readFileSync(relaunchMarker, 'utf8'), 'requested');
    assert.equal(fs.readFileSync(path.join(desktop, 'main.js'), 'utf8'), changedMain);
    assert.equal(fs.readFileSync(path.join(desktop, 'local-data', 'holdings.json'), 'utf8'), holdings);
    assert.equal(JSON.parse(fs.readFileSync(path.join(desktop, 'desktop-release.json'), 'utf8')).version, nextVersion);
    if (realRelaunch) {
      await until(() => fs.existsSync(restartEvidence));
      const evidence = JSON.parse(fs.readFileSync(restartEvidence, 'utf8'));
      assert.equal(evidence.error, undefined);
      assert.equal(evidence.version, nextVersion);
      assert.match(evidence.title, /更新后的测试桌面/);
      assert.deepEqual(evidence.holdings, JSON.parse(holdings));
      const processes = fs.readFileSync(startupLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(processes.length, 2);
      assert.notEqual(processes[0].pid, evidence.pid);
      assert.equal(processes[1].pid, evidence.pid);
      await until(() => !processExists(evidence.pid), 25000);
      console.log(`Isolated Electron update to ${nextVersion} passed; actual app.relaunch started a new process and it exited.`);
    } else {
      // In default mode the request is intercepted; the test runner launches the new process.
      app = await launch();
      const reopened = await app.firstWindow();
      assert.match(await reopened.locator('#analysis-title').innerText(), /更新后的测试桌面/);
      await reopened.click('.navigation [data-page="holdings"]');
      await reopened.waitForFunction(() => document.querySelector('#holdings-total').textContent === '1');
      assert.match(await reopened.locator('#holdings-list').innerText(), /600172.SS/);
      console.log(`Isolated Electron update to ${nextVersion} passed; relaunch was intercepted and started by test runner.`);
    }
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
