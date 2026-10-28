const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdateService, recoverUiUpdate, UI_FILES, parseManifest } = require('./update-service');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const OLD_SHA = '1'.repeat(40), NEW_SHA = '2'.repeat(40), UI_SHA = '3'.repeat(40);
function manifest(version, files, hostVersion = '0.2.0') {
  return { schema: 1, version, hostVersion, files: Object.fromEntries(UI_FILES.map(name => [name, hash(files[name])])) };
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-ui-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldFiles = Object.fromEntries(UI_FILES.map(name => [name, Buffer.from(`old ${name}\n`)]));
  const newFiles = Object.fromEntries(UI_FILES.map(name => [name, Buffer.from(`new ${name}\n`)]));
  const oldManifest = manifest('0.2.0', oldFiles);
  for (const name of UI_FILES) fs.writeFileSync(path.join(dir, name), oldFiles[name]);
  fs.writeFileSync(path.join(dir, 'ui-release.json'), JSON.stringify(oldManifest));
  fs.mkdirSync(path.join(dir, 'local-data'));
  fs.writeFileSync(path.join(dir, 'local-data', 'private-report.txt'), 'private report');
  const context = { dir, oldFiles, newFiles, oldManifest, remoteManifest: manifest('0.3.0', newFiles), requests: [], networkError: false, comparison: 'ahead', latestKernelSha: NEW_SHA, origin: 'https://github.com/TauricResearch/TradingAgents.git', clock: 1000 };
  const fetchImpl = async (url, init) => {
    context.requests.push({ url, init });
    if (context.networkError) throw new Error('offline');
    if (url.endsWith('/TauricResearch/TradingAgents/git/ref/heads/main')) return Response.json({ object: { sha: context.latestKernelSha } });
    if (url.includes('/TauricResearch/TradingAgents/compare/')) {
      assert.equal(new URL(url).search, '?per_page=1&page=2');
      return Response.json({ status: context.comparison, ahead_by: context.comparison === 'ahead' ? 1 : 0 });
    }
    if (url.includes('/commits?')) return Response.json([{ sha: UI_SHA }]);
    if (url.endsWith('/ui-release.json')) return Response.json(context.remoteManifest);
    const name = url.split('/').pop();
    if (Object.hasOwn(newFiles, name)) return new Response(context.corruptDownload ? 'corrupt' : newFiles[name]);
    throw new Error('Unexpected URL');
  };
  const git = async args => {
    if (args[0] === 'remote') return context.origin;
    if (args[0] === 'branch') return 'main';
    if (args[0] === 'rev-parse') return OLD_SHA;
    if (args[0] === 'describe') return 'v0.7.0';
    throw new Error('Unexpected git');
  };
  context.service = createUpdateService({ desktopDir: dir, repo: dir, hostVersion: '0.2.0', fetchImpl, git, now: () => context.clock, ...options });
  return context;
}

test('independent public checks identify updates and do not send user data', async t => {
  const f = fixture(t);
  const state = await f.service.check();
  assert.deepEqual(state.kernel, { current: 'v0.7.0', latest: NEW_SHA.slice(0, 7), available: true, status: 'available' });
  assert.deepEqual(state.ui, { current: '0.2.0', latest: '0.3.0', available: true, status: 'available' });
  assert.ok(f.requests.some(({ url }) => url.endsWith('/git/ref/heads/main')));
  assert.ok(f.requests.some(({ url }) => url.endsWith(`compare/${OLD_SHA}...${NEW_SHA}?per_page=1&page=2`)));
  for (const { url, init } of f.requests) {
    assert.match(url, /^https:\/\/(api.github.com|raw.githubusercontent.com)\//);
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, undefined);
    assert.doesNotMatch(url, /private-report|api-key/);
  }
  const count = f.requests.length;
  await f.service.check();
  assert.equal(f.requests.length, count);
  f.clock += 6 * 60 * 60 * 1000;
  await f.service.check();
  assert.ok(f.requests.length > count);
});

test('failed checks preserve confirmed update badge without claiming current', async t => {
  const f = fixture(t);
  await f.service.check();
  f.networkError = true;
  const state = await f.service.check({ force: true });
  assert.equal(state.ui.status, 'error');
  assert.equal(state.ui.available, true);
  assert.equal(state.ui.latest, '0.3.0');
  assert.equal(state.kernel.status, 'error');
  assert.match(state.kernel.error, /网络/);
});

test('an initial network failure still shows installed versions', async t => {
  const f = fixture(t); f.networkError = true;
  const state = await f.service.check();
  assert.equal(state.ui.current, '0.2.0');
  assert.equal(state.kernel.current, 'v0.7.0');
  assert.equal(state.ui.available, false);
  assert.equal(state.ui.status, 'error');
});

test('unfinished kernel installation needs retry even at latest SHA or offline, and clears after success', async t => {
  const f = fixture(t); f.latestKernelSha = OLD_SHA;
  const marker = path.join(f.dir, 'update-incomplete');
  assert.equal((await f.service.check()).kernel.status, 'current');
  fs.writeFileSync(marker, 'Dependency installation interrupted');
  const cached = await f.service.check();
  assert.equal(cached.kernel.status, 'error');
  assert.equal(cached.kernel.available, true);
  assert.match(cached.kernel.error, /未完成.*重试/);
  f.networkError = true;
  const offline = await f.service.check({ force: true });
  assert.equal(offline.kernel.status, 'error');
  assert.equal(offline.kernel.available, true);
  assert.match(offline.kernel.error, /未完成.*重试/);
  fs.unlinkSync(marker);
  f.networkError = false;
  const recovered = await f.service.check({ force: true });
  assert.equal(recovered.kernel.status, 'current');
  assert.equal(recovered.kernel.available, false);
  assert.equal(recovered.kernel.error, undefined);
});

test('unfinished kernel update does not override a blocked repository safety check', async t => {
  const f = fixture(t); f.origin = 'https://github.com/other/project.git';
  fs.writeFileSync(path.join(f.dir, 'update-incomplete'), 'interrupted');
  const state = await f.service.check();
  assert.equal(state.kernel.status, 'blocked');
  assert.equal(state.kernel.available, true);
  assert.match(state.kernel.error, /未完成/);
  assert.match(state.kernel.error, /origin/);
});

test('ahead local kernel is not falsely offered an update; diverged kernel is blocked', async t => {
  const f = fixture(t);
  f.comparison = 'behind';
  assert.equal((await f.service.check()).kernel.available, false);
  f.comparison = 'diverged';
  assert.equal((await f.service.check({ force: true })).kernel.status, 'blocked');
});

test('UI host mismatch keeps new-version notice but prevents installation', async t => {
  const f = fixture(t); f.remoteManifest.hostVersion = '0.9.0';
  const state = await f.service.check();
  assert.equal(state.ui.available, true);
  assert.equal(state.ui.status, 'blocked');
  await assert.rejects(f.service.installUi(), /完整桌面/);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'index.html')), f.oldFiles['index.html']);
});

test('manifest rejects traversal, extra files, malformed versions and invalid hashes', () => {
  const files = Object.fromEntries(UI_FILES.map(name => [name, Buffer.from(name)]));
  const valid = manifest('0.3.0', files);
  assert.equal(parseManifest(Buffer.from(JSON.stringify(valid))).version, '0.3.0');
  for (const invalid of [
    { ...valid, files: { ...valid.files, '../secret': 'a'.repeat(64) } },
    { ...valid, files: { ...valid.files, 'main.js': 'a'.repeat(64) } },
    { ...valid, version: '0.3.0-beta' },
    { ...valid, version: '0.3.0\n' },
    { ...valid, hostVersion: '0.2.0\r\n' },
    { ...valid, files: { ...valid.files, 'index.html': '../../data' } },
    { ...valid, files: { ...valid.files, 'index.html': 'a'.repeat(64) + '\n' } },
  ]) assert.throws(() => parseManifest(Buffer.from(JSON.stringify(invalid))), /格式无效/);
});

test('local UI edits and corrupt downloads are never overwritten', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'renderer.js'), 'local customization');
  await assert.rejects(f.service.installUi(), /本地修改/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'renderer.js'), 'utf8'), 'local customization');
  fs.writeFileSync(path.join(f.dir, 'renderer.js'), f.oldFiles['renderer.js']);
  f.corruptDownload = true;
  await assert.rejects(f.service.installUi(), /校验失败/);
  for (const name of UI_FILES) assert.deepEqual(fs.readFileSync(path.join(f.dir, name)), f.oldFiles[name]);
  assert.equal(fs.existsSync(path.join(f.dir, 'local-data', 'ui-update-pending.json')), false);
});

test('UI install replaces only allowlisted files, records backup and clears update notice', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'main.js'), 'host must remain');
  assert.match(await f.service.installUi(), /0.3.0/);
  for (const name of UI_FILES) assert.deepEqual(fs.readFileSync(path.join(f.dir, name)), f.newFiles[name]);
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.js'), 'utf8'), 'host must remain');
  assert.equal(fs.readFileSync(path.join(f.dir, 'local-data', 'private-report.txt'), 'utf8'), 'private report');
  const backupId = fs.readdirSync(path.join(f.dir, 'local-data', 'ui-update-backups'))[0];
  for (const name of UI_FILES) assert.deepEqual(fs.readFileSync(path.join(f.dir, 'local-data', 'ui-update-backups', backupId, name)), f.oldFiles[name]);
  assert.equal((await f.service.check()).ui.available, false);
  assert.equal((await f.service.check({ force: true })).ui.current, '0.3.0');
  assert.equal(recoverUiUpdate(f.dir), false);
});

test('partial write failure rolls back all UI files immediately', async t => {
  let failed = false;
  const io = { ...fs, renameSync: (source, target) => {
    if (!failed && path.basename(target) === 'renderer.js') { failed = true; throw new Error('simulated write failure'); }
    return fs.renameSync(source, target);
  } };
  const f = fixture(t, { io });
  await assert.rejects(f.service.installUi(), /已恢复原版本/);
  for (const name of UI_FILES) assert.deepEqual(fs.readFileSync(path.join(f.dir, name)), f.oldFiles[name]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'ui-release.json'), 'utf8')).version, '0.2.0');
  assert.equal(recoverUiUpdate(f.dir), false);
});

test('a persistent write failure leaves a recovery journal and next startup restores old UI', async t => {
  const io = { ...fs, renameSync: (source, target) => {
    if (path.basename(target) === 'renderer.js') throw new Error('simulated locked file');
    return fs.renameSync(source, target);
  } };
  const f = fixture(t, { io });
  await assert.rejects(f.service.installUi(), /自动恢复未完成/);
  assert.equal(fs.existsSync(path.join(f.dir, 'local-data', 'ui-update-pending.json')), true);
  assert.equal(recoverUiUpdate(f.dir), true);
  for (const name of UI_FILES) assert.deepEqual(fs.readFileSync(path.join(f.dir, name)), f.oldFiles[name]);
});

test('recovery refuses unexpected post-interruption edits and unsafe backup paths', async t => {
  const io = { ...fs, renameSync: (source, target) => {
    if (path.basename(target) === 'renderer.js') throw new Error('locked');
    return fs.renameSync(source, target);
  } };
  const f = fixture(t, { io });
  await assert.rejects(f.service.installUi());
  fs.writeFileSync(path.join(f.dir, 'index.html'), 'user edit after interruption');
  assert.throws(() => recoverUiUpdate(f.dir), /另有修改/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'user edit after interruption');
  const journalPath = path.join(f.dir, 'local-data', 'ui-update-pending.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.backupId = '../outside';
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(() => recoverUiUpdate(f.dir), /恢复记录无效/);
});

test('directory junctions cannot redirect update backups outside installation', async t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-ui-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.dir, 'local-data', 'ui-update-backups'), 'junction');
  await assert.rejects(f.service.installUi(), /包含链接/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
