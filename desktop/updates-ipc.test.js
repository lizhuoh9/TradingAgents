// Exercise the real main-process handlers without downloading code or opening the user's app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function harness() {
  const handlers = new Map(), commands = [];
  const state = { uiInstalls: 0, reloads: 0, relaunches: 0, exits: 0, quits: 0, recoveries: 0, marker: false, failInstall: false, failPip: false, recoverError: false };
  const updates = { check: async ({ force }) => ({ forced: force }) };
  const fakeFs = { ...fs, existsSync: target => path.basename(target) === 'update-incomplete' ? state.marker : path.basename(target) === 'desktop-update-pending.json' ? !!state.desktopPending : false,
    writeFileSync: () => { state.marker = true; }, unlinkSync: () => { state.marker = false; } };
  const childProcess = {
    execFile: (_exe, _args, _options, callback) => { state.finishProfile = () => callback(null); },
    execFileSync: (_exe, args) => args[0] === 'remote' ? 'https://github.com/TauricResearch/TradingAgents.git' : 'main',
    spawn: (exe, args) => {
      commands.push({ exe, args });
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      process.nextTick(() => child.emit('close', state.failPip && args.includes('pip') ? 1 : 0));
      return child;
    },
  };
  class Window {
    constructor() { this.webContents = { send() {}, setWindowOpenHandler() {}, on() {}, reload() { state.reloads++; } }; }
    on() {} loadFile() {} isDestroyed() { return false; }
  }
  const replacements = {
    electron: { app: { requestSingleInstanceLock: () => true, whenReady: async () => {}, on() {}, quit() { state.quits++; }, relaunch() { state.relaunches++; if (state.failRelaunch) throw new Error('relaunch failed'); }, exit() { state.exits++; } }, BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, shell: {}, safeStorage: {}, dialog: { showErrorBox() {} } },
    'node:fs': fakeFs, 'node:child_process': childProcess,
    './repo-path': { officialRepoPath: () => path.join(__dirname, 'fake-official') },
    './update-service': { createUpdateService: () => updates, recoverUiUpdate() { if (state.recoverError) throw new Error('recovery required'); } },
    './desktop-update': { createDesktopUpdater: () => ({ check: async () => ({ current: '0.4.0', latest: '0.5.0', available: true, status: 'available' }), install: async () => { state.uiInstalls++; if (state.failInstall) throw new Error('download failed'); return { installed: !state.noUpdate, version: '0.5.0' }; } }) },
    './profile-store': { createProfileStore: () => ({ put: () => ({ profiles: [] }) }), validProfile: () => ({ provider: 'mock' }) },
    './data-key-store': { createDataKeyStore: () => ({}) },
    './watchlist-store': { createWatchlistStore: () => ({}) },
    './report-store': { createReportStore: () => ({}) },
    './a-share-screener': { createAShareScreener: () => ({}) },
  };
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  vm.runInNewContext(source, { require: name => replacements[name] || require(name), __dirname, process, console });
  await new Promise(resolve => setImmediate(resolve));
  const invoke = (name, value) => Promise.resolve().then(() => handlers.get(name)({}, value));
  return { state, commands, invoke, handlers };
}

test('update IPC accepts only explicit channels and separates UI from kernel installation', async () => {
  const h = await harness();
  for (const target of [undefined, '../data', 'all', { target: 'ui' }]) await assert.rejects(h.invoke('update', target), /请选择/);
  await assert.rejects(h.invoke('updates-check', 'true'), /参数无效/);
  assert.equal((await h.invoke('updates-check', true)).forced, true);
  await h.invoke('update', 'kernel');
  assert.equal(h.state.uiInstalls, 0);
  assert.ok(h.commands.some(command => command.args.join(' ') === 'pull --ff-only origin main'));
  assert.ok(h.commands.some(command => command.args.join(' ') === '-m pip install -e .'));
  assert.equal(h.state.marker, false);
  await h.invoke('update', 'ui');
  assert.equal(h.state.uiInstalls, 1);
  assert.equal(h.state.relaunches, 1);
  assert.equal(h.state.exits, 1);
  await assert.rejects(h.invoke('run', {}), /请先重启/);
});

test('checking a current desktop version does not restart the app', async () => {
  const h = await harness(); h.state.noUpdate = true;
  assert.match(await h.invoke('update', 'ui'), /最新/);
  assert.equal(h.state.relaunches, 0);
  assert.equal(h.state.exits, 0);
});

test('if automatic relaunch fails all app actions wait for a manual restart', async () => {
  const h = await harness(); h.state.failRelaunch = true;
  await assert.rejects(h.invoke('update', 'ui'), /关闭后重新启动/);
  for (const name of ['run', 'watchlist-add', 'holdings-add', 'profile-save', 'reports-list', 'updates-check']) {
    await assert.rejects(h.invoke(name, {}), /请先重启/);
  }
});

test('an incomplete desktop rollback blocks all app actions until restart', async () => {
  const h = await harness(); h.state.failInstall = true; h.state.desktopPending = true;
  await assert.rejects(h.invoke('update', 'ui'), /download failed/);
  for (const name of ['run', 'watchlist-add', 'holdings-add', 'profile-save', 'updates-check']) {
    await assert.rejects(h.invoke(name, {}), /请先重启/);
  }
});

test('active task blocks both installers and reload; a failed installer releases the task lock', async () => {
  const h = await harness();
  const save = h.invoke('profile-save', {});
  await new Promise(resolve => setImmediate(resolve));
  for (const target of ['kernel', 'ui']) await assert.rejects(h.invoke('update', target), /正在运行/);
  await assert.rejects(h.invoke('ui-reload'), /任务进行中/);
  h.state.finishProfile(); await save;
  h.state.failInstall = true;
  await assert.rejects(h.invoke('update', 'ui'), /download failed/);
  await h.invoke('ui-reload');
  assert.equal(h.state.reloads, 1);
});

test('incomplete kernel or UI update cannot start single or batch analyses', async () => {
  const h = await harness();
  h.state.failPip = true;
  await assert.rejects(h.invoke('update', 'kernel'), /依赖安装失败/);
  assert.equal(h.state.marker, true);
  for (const name of ['run', 'run-batch']) await assert.rejects(h.invoke(name, {}), /内核更新未完成/);
  h.state.marker = false; h.state.recoverError = true;
  for (const name of ['run', 'run-batch', 'ui-reload']) await assert.rejects(h.invoke(name, {}), /recovery required/);
});
