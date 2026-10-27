const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createAnalysisControl } = require('./analysis-control');

test('only an active analysis can be stopped, once', () => {
  const control = createAnalysisControl();
  assert.deepEqual(control.stop(), { requested: false });
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, kills: 0, kill() { this.kills++; return true; } });
  const task = control.attach(child);
  assert.deepEqual(control.stop(), { requested: true });
  assert.deepEqual(control.stop(), { requested: true });
  assert.equal(child.kills, 1);
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
  assert.equal(task.closeSignal, 'SIGTERM');
  assert.deepEqual(control.stop(), { requested: false });
  const complete = new EventEmitter();
  Object.assign(complete, { exitCode: 0, signalCode: null, kill() { throw new Error('must not kill completed process'); } });
  control.attach(complete);
  assert.deepEqual(control.stop(), { requested: false });
  complete.emit('close', 0, null);
});
test('a spawn error releases the slot before its later close event', () => {
  const control = createAnalysisControl();
  const failed = new EventEmitter();
  Object.assign(failed, { exitCode: null, signalCode: null, pid: undefined });
  control.attach(failed);
  failed.emit('error', new Error('spawn failed'));
  const retry = new EventEmitter();
  Object.assign(retry, { exitCode: null, signalCode: null, pid: 1, kill() { return true; } });
  control.attach(retry);
  failed.emit('close', null, null);
  assert.deepEqual(control.stop(), { requested: true });
  retry.emit('close', null, 'SIGTERM');
});
test('a failed stop signal permits retry while preserving the active task', () => {
  const control = createAnalysisControl();
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, pid: 42, kills: 0, kill() { this.kills++; return true; } });
  const task = control.attach(child);
  assert.deepEqual(control.stop(), { requested: true });
  child.emit('error', new Error('test failure'));
  assert.equal(task.stopRequested, false);
  assert.deepEqual(control.stop(), { requested: true });
  assert.equal(child.kills, 2);
  child.emit('close', null, 'SIGTERM');
});

const { officialRepoPath } = require('./repo-path');
const configPath = path.join(officialRepoPath(__dirname), '.venv-win/pyvenv.cfg');
const virtualPython = path.join(officialRepoPath(__dirname), '.venv-win/Scripts/python.exe');
const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
const basePython = config.match(/^executable\s*=\s*(.+?)\s*$/im)?.[1];
const jobScript = path.join(__dirname, 'job_supervisor.py');
const available = process.platform === 'win32' && basePython && fs.existsSync(basePython) && fs.existsSync(virtualPython);

function launch(args) {
  return spawn(basePython, [jobScript, ...args], { cwd: __dirname, env: { ...process.env, PYTHONUTF8: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('test analysis did not start')), 15000);
    child.stdout.on('data', data => {
      output += data.toString();
      const match = output.match(/READY (\d+) (\d+) (\d+) (\d+)/);
      if (match) { clearTimeout(timer); resolve(match.slice(1).map(Number)); }
    });
    child.once('close', () => { clearTimeout(timer); if (!output.includes('READY ')) reject(new Error('test analysis exited before starting')); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}
async function waitGone(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`test process ${pid} still exists`);
}

test('Windows job preserves normal, failed and startup-error exit codes', { skip: !available, timeout: 30000 }, async () => {
  for (const [args, expected] of [
    [[virtualPython, '-c', 'pass'], 0],
    [[virtualPython, '-c', 'import sys; sys.exit(7)'], 7],
    [['Z:\\missing-analysis-program.exe'], 1],
  ]) {
    const child = launch(args);
    child.stdout.resume(); child.stderr.resume();
    const [code, signal] = await once(child, 'close');
    assert.equal(code, expected); assert.equal(signal, null);
  }
});

test('stopping Windows job ends venv analysis tree but leaves unrelated process alive', { skip: !available, timeout: 30000 }, async t => {
  const script = "import os,subprocess,sys,time; p=subprocess.Popen([sys.executable,'-u','-c','import os,time; print(os.getpid(),flush=True); time.sleep(120)'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL); descendant=int(p.stdout.readline()); print('READY',os.getpid(),os.getppid(),p.pid,descendant,flush=True); time.sleep(120)";
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const supervisor = launch([virtualPython, '-u', '-c', script]);
  const control = createAnalysisControl();
  const task = control.attach(supervisor);
  t.after(() => { if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill(); if (other.exitCode === null && other.signalCode === null) other.kill(); });
  supervisor.stderr.resume();
  const processTree = await waitForReady(supervisor);
  const finished = once(supervisor, 'close');
  assert.deepEqual(control.stop(), { requested: true });
  const [code, signal] = await finished;
  assert.equal(code, null); assert.equal(signal, 'SIGTERM'); assert.equal(task.closeSignal, 'SIGTERM');
  for (const pid of new Set(processTree)) await waitGone(pid);
  assert.doesNotThrow(() => process.kill(other.pid, 0));
});

test('stopping immediately and after natural completion does not target a reused pid', { skip: !available, timeout: 30000 }, async () => {
  const control = createAnalysisControl();
  const early = launch([virtualPython, '-c', 'import time; time.sleep(120)']);
  early.stdout.resume(); early.stderr.resume(); control.attach(early);
  const closed = once(early, 'close');
  assert.deepEqual(control.stop(), { requested: true });
  const [_code, signal] = await closed; assert.equal(signal, 'SIGTERM');
  const normal = launch([virtualPython, '-c', 'pass']);
  normal.stdout.resume(); normal.stderr.resume(); control.attach(normal);
  const [code] = await once(normal, 'close'); assert.equal(code, 0);
  assert.deepEqual(control.stop(), { requested: false });
});
