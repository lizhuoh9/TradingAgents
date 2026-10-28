const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'desktop-launcher.js'), 'utf8');
function launch({ lock = true, recovered = false, fail = false, legacyPending = false } = {}) {
  const calls = [];
  const app = { requestSingleInstanceLock() { calls.push('lock'); return lock; }, quit() { calls.push('quit'); }, relaunch() { calls.push('relaunch'); }, exit() { calls.push('exit'); } };
  const requireMock = name => {
    if (name === 'electron') return { app, dialog: { showErrorBox() { calls.push('error'); } } };
    if (name === './desktop-update') { calls.push('load-recovery'); return { recoverDesktopUpdate() { calls.push('recover'); if (fail) throw new Error('bad backup'); return recovered; } }; }
    if (name === 'node:fs') return { existsSync: () => legacyPending };
    if (name === 'node:path') return path;
    if (name === './main') { calls.push('load-main'); return {}; }
    throw new Error('Unexpected module');
  };
  try { vm.runInNewContext(source, { require: requireMock, __dirname }); } catch (error) { calls.push(error.message); }
  return calls;
}
test('a second instance does not touch an update in progress', () => assert.deepEqual(launch({ lock: false }), ['lock', 'quit']));
test('recovery occurs before main is loaded', () => assert.deepEqual(launch(), ['lock', 'load-recovery', 'recover', 'load-main']));
test('a recovered update restarts before loading the main program', () => assert.deepEqual(launch({ recovered: true }), ['lock', 'load-recovery', 'recover', 'relaunch', 'exit']));
test('failed recovery stops before loading the main program', () => assert.deepEqual(launch({ fail: true }), ['lock', 'load-recovery', 'recover', 'error', 'exit', 'bad backup']));
test('an interrupted legacy UI update requires recovery with the old version', () => assert.deepEqual(launch({ legacyPending: true }), ['lock', 'load-recovery', 'recover', 'error', 'exit']));
