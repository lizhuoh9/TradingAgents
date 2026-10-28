const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDesktopUpdater, recoverDesktopUpdate, fileHash, parseManifest } = require('./desktop-update');

const sha = 'a'.repeat(40);
const pack = version => JSON.stringify({ name: 'test', version, main: 'desktop-launcher.js', devDependencies: { electron: '^45.0.0' } });
const lock = version => JSON.stringify({ name: 'test', version, packages: { '': { name: 'test', version, devDependencies: { electron: '^45.0.0' } } } });
const manifest = (version, files) => Buffer.from(JSON.stringify({ schema: 1, version, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, fileHash(name, Buffer.from(bytes))])) }));
const response = value => ({ ok: true, headers: { get: () => null }, body: { getReader: () => { let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from(value) }), cancel: async () => {} }; } } });
function fixture(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-updater-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = { 'desktop-launcher.js': 'launcher', 'desktop-update.js': 'bootstrap', 'main.js': 'old main', 'index.html': 'old index', 'renderer.js': 'old renderer', 'style.css': 'old style', 'ui-release.json': '{}', 'package.json': pack('0.4.0'), 'package-lock.json': lock('0.4.0') };
  const next = { 'new-feature.js': 'feature', ...old, 'main.js': 'new main', 'index.html': 'new index', 'package.json': pack('0.5.0'), 'package-lock.json': lock('0.5.0') };
  for (const [name, bytes] of Object.entries(old)) fs.writeFileSync(path.join(dir, name), bytes);
  fs.writeFileSync(path.join(dir, 'desktop-release.json'), manifest('0.4.0', old));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://api.github.com/')) return response(JSON.stringify([{ sha }]));
    const name = url.split('/desktop/')[1];
    if (name === 'desktop-release.json') return response(manifest('0.5.0', next));
    if (!(name in next)) throw new Error('unexpected file');
    return response(next[name]);
  };
  return { dir, old, next, calls, fetchImpl, updater: createDesktopUpdater({ desktopDir: dir, fetchImpl, ...opts }) };
}

test('full update pins all downloads, preserves user data and reports install status', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'local-data')); fs.writeFileSync(path.join(f.dir, 'local-data', 'holdings.json'), 'private');
  assert.deepEqual(await f.updater.check(), { current: '0.4.0', latest: '0.5.0', available: true, status: 'available' });
  assert.deepEqual(await f.updater.install(), { installed: true, version: '0.5.0' });
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.js'), 'utf8'), 'new main');
  assert.equal(fs.readFileSync(path.join(f.dir, 'new-feature.js'), 'utf8'), 'feature');
  assert.equal(fs.readFileSync(path.join(f.dir, 'local-data', 'holdings.json'), 'utf8'), 'private');
  assert.equal(recoverDesktopUpdate(f.dir), false);
  assert.ok(f.calls.filter(call => call.url.includes('raw.githubusercontent')).every(call => call.url.includes('/' + sha + '/desktop/')));
  assert.ok(f.calls.every(call => call.options.redirect === 'error'));
  assert.deepEqual(await f.updater.install(), { installed: false, version: '0.5.0' });
});

test('refuses edited baseline, an existing new file, changed bootstrap, or changed dependency', async t => {
  for (const scenario of ['edit', 'conflict', 'bootstrap', 'deps']) {
    const f = fixture(t);
    if (scenario === 'edit') fs.writeFileSync(path.join(f.dir, 'main.js'), 'user edit');
    if (scenario === 'conflict') fs.writeFileSync(path.join(f.dir, 'new-feature.js'), 'user file');
    if (scenario === 'bootstrap') f.next['desktop-update.js'] = 'changed bootstrap';
    if (scenario === 'deps') f.next['package.json'] = JSON.stringify({ name: 'test', version: '0.5.0', main: 'desktop-launcher.js', devDependencies: { electron: '^99' } });
    await assert.rejects(f.updater.install(), /本地修改|本地文件|手动升级/);
    assert.equal(fs.existsSync(path.join(f.dir, 'local-data', 'desktop-update-pending.json')), false);
    if (scenario === 'conflict') assert.equal(fs.readFileSync(path.join(f.dir, 'new-feature.js'), 'utf8'), 'user file');
  }
});

test('refuses corrupted downloads before changing the installation', async t => {
  const f = fixture(t);
  const fetchImpl = async (url, options) => url.endsWith('/desktop/main.js') ? response('unexpected content') : f.fetchImpl(url, options);
  await assert.rejects(createDesktopUpdater({ desktopDir: f.dir, fetchImpl }).install(), /校验失败/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.js'), 'utf8'), f.old['main.js']);
  assert.equal(fs.existsSync(path.join(f.dir, 'new-feature.js')), false);
});

test('a pending journal blocks installation until the launcher restarts and recovers', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'local-data'));
  const journal = path.join(f.dir, 'local-data', 'desktop-update-pending.json');
  fs.writeFileSync(journal, 'preserve pending recovery');
  await assert.rejects(f.updater.install(), /关闭并重启程序/);
  assert.equal(fs.readFileSync(journal, 'utf8'), 'preserve pending recovery');
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.js'), 'utf8'), f.old['main.js']);
  assert.equal(f.calls.length, 0);
});

test('a write failure rolls back previously changed files and newly created files', async t => {
  let failed = false;
  const io = { ...fs, renameSync(from, to) { if (!failed && to.endsWith('package.json')) { failed = true; throw new Error('injected'); } return fs.renameSync(from, to); } };
  const f = fixture(t, { io });
  await assert.rejects(f.updater.install(), /已恢复原版本/);
  for (const [name, bytes] of Object.entries(f.old)) assert.equal(fs.readFileSync(path.join(f.dir, name), 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(f.dir, 'new-feature.js')), false);
  assert.equal(recoverDesktopUpdate(f.dir), false);
});

test('a failure before hard-linking cleans up its marker without creating a target', async t => {
  const io = { ...fs, linkSync() { throw new Error('injected'); } };
  const f = fixture(t, { io });
  await assert.rejects(f.updater.install(), /已恢复原版本/);
  assert.equal(fs.existsSync(path.join(f.dir, 'new-feature.js')), false);
  assert.equal(fs.readdirSync(f.dir).some(name => name.startsWith('new-feature.js.desktop-update-')), false);
});

test('an interrupted partial temporary write does not block startup recovery', async t => {
  const isPartial = target => target.includes('.desktop-update-') && target.includes('.tmp-');
  const io = { ...fs,
    writeFileSync(target, bytes, options) { if (isPartial(target)) { fs.writeFileSync(target, 'partial', options); throw new Error('interrupted'); } return fs.writeFileSync(target, bytes, options); },
    unlinkSync(target) { if (isPartial(target)) throw new Error('process interrupted'); return fs.unlinkSync(target); },
  };
  const f = fixture(t, { io });
  await assert.rejects(f.updater.install(), /已恢复原版本/);
  assert.equal(fs.existsSync(path.join(f.dir, 'new-feature.js')), false);
  const partial = fs.readdirSync(f.dir).find(name => isPartial(name));
  assert.ok(partial);
  assert.equal(fs.readFileSync(path.join(f.dir, partial), 'utf8'), 'partial');
  assert.equal(recoverDesktopUpdate(f.dir), false);
});

test('a concurrently created identical file is never deleted during recovery', async t => {
  const io = { ...fs, linkSync(from, target) { if (target.endsWith('new-feature.js')) fs.writeFileSync(target, 'feature'); return fs.linkSync(from, target); } };
  const f = fixture(t, { io });
  await assert.rejects(f.updater.install(), /自动恢复未完成/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'new-feature.js'), 'utf8'), 'feature');
  assert.throws(() => recoverDesktopUpdate(f.dir), /新增文件另有修改/);
});

test('interrupted recovery preserves unexpected edits and can resume after repair', async t => {
  let fail = true;
  const io = { ...fs, renameSync(from, to) { if (fail && to.endsWith('package.json')) throw new Error('injected'); return fs.renameSync(from, to); } };
  const f = fixture(t, { io });
  await assert.rejects(f.updater.install(), /自动恢复未完成/);
  assert.ok(fs.existsSync(path.join(f.dir, 'local-data', 'desktop-update-pending.json')));
  fs.writeFileSync(path.join(f.dir, 'main.js'), 'user edit');
  assert.throws(() => recoverDesktopUpdate(f.dir), /另有修改/);
  fs.writeFileSync(path.join(f.dir, 'main.js'), f.next['main.js']); fail = false;
  assert.equal(recoverDesktopUpdate(f.dir), true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.js'), 'utf8'), f.old['main.js']);
});

test('rejects traversal and sensitive data names and handles line-ending normalization', () => {
  const files = { 'desktop-launcher.js': 'x', 'desktop-update.js': 'x', 'main.js': 'x', 'index.html': 'x', 'renderer.js': 'x', 'style.css': 'x', 'ui-release.json': '{}', 'package.json': '{}', 'package-lock.json': '{}' };
  const valid = JSON.parse(manifest('0.4.0', files));
  for (const name of ['../main.js', 'local-data/holdings.json', 'node_modules/x.js', '.env', 'x\\y.js', 'nul.js']) {
    assert.throws(() => parseManifest(Buffer.from(JSON.stringify({ ...valid, files: { ...valid.files, [name]: 'f'.repeat(64) } }))), /无效/);
  }
  assert.equal(fileHash('main.js', Buffer.from('x\r\ny')), fileHash('main.js', Buffer.from('x\ny')));
});
