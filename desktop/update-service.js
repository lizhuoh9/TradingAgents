const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { cleanEnvironment } = require('./environment');

const UI_FILES = ['index.html', 'renderer.js', 'style.css'];
const MANIFEST = 'ui-release.json';
const JOURNAL = 'local-data/ui-update-pending.json';
const OFFICIAL = 'https://github.com/TauricResearch/TradingAgents.git';
const API = 'https://api.github.com/repos/';
const UI_REPO = 'lizhuoh9/TradingAgents';
const TTL = 6 * 60 * 60 * 1000;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const validSha = value => typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value);
const validVersion = value => typeof value === 'string' && value === value.trim() && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value);

function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}

function parseManifest(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('界面版本清单无法读取'); }
  if (!value || value.schema !== 1 || !validVersion(value.version) || !validVersion(value.hostVersion) || !value.files ||
      Object.keys(value.files).sort().join('|') !== [...UI_FILES].sort().join('|') || UI_FILES.some(name => !validHash(value.files[name]))) {
    throw new Error('界面版本清单格式无效，未更改本机文件');
  }
  return value;
}

// Update targets are fixed files; even a local junction must not redirect a write outside this installation.
function safePath(root, relative, io = fs) {
  const pieces = relative.split('/');
  if (pieces.some(piece => !piece || piece === '.' || piece === '..' || /[\\:]/.test(piece))) throw new Error('更新路径无效');
  let current = path.resolve(root);
  for (const piece of ['', ...pieces]) {
    if (piece) current = path.join(current, piece);
    if (io.existsSync(current) && io.lstatSync(current).isSymbolicLink()) throw new Error('更新目录包含链接，已停止以保护本机文件');
  }
  return current;
}

function atomicWrite(root, name, bytes, io = fs) {
  const target = safePath(root, name, io);
  const temporary = `${target}.update-${crypto.randomUUID()}`;
  try {
    io.writeFileSync(temporary, bytes, { flag: 'wx' });
    io.renameSync(temporary, target);
  } finally {
    if (io.existsSync(temporary)) io.unlinkSync(temporary);
  }
}

function localManifest(desktopDir, io = fs) {
  return parseManifest(io.readFileSync(safePath(desktopDir, MANIFEST, io)));
}

function assertBaseline(desktopDir, manifest, io = fs) {
  for (const name of UI_FILES) {
    if (hash(io.readFileSync(safePath(desktopDir, name, io))) !== manifest.files[name]) throw new Error('界面源码有本地修改，已停止更新；请先备份并处理修改');
  }
}

function recoverUiUpdate(desktopDir, io = fs) {
  const journalPath = safePath(desktopDir, JOURNAL, io);
  if (!io.existsSync(journalPath)) return false;
  let journal;
  try { journal = JSON.parse(io.readFileSync(journalPath, 'utf8')); } catch { throw new Error('界面更新恢复记录损坏，请保留本机备份并修复安装'); }
  if (journal?.schema !== 1 || journal.backupId?.length !== 36 || !/^[a-f0-9-]{36}$/.test(journal.backupId || '') || !validHash(journal.previousManifestHash) ||
      !validHash(journal.nextManifestHash) || !journal.nextFiles || Object.keys(journal.nextFiles).sort().join('|') !== [...UI_FILES].sort().join('|') ||
      UI_FILES.some(name => !validHash(journal.nextFiles[name]))) throw new Error('界面更新恢复记录无效，未覆盖文件');
  const backup = safePath(desktopDir, `local-data/ui-update-backups/${journal.backupId}`, io);
  const oldManifestBytes = io.readFileSync(safePath(backup, MANIFEST, io));
  if (hash(oldManifestBytes) !== journal.previousManifestHash) throw new Error('界面备份校验失败，未覆盖文件');
  const oldManifest = parseManifest(oldManifestBytes);
  assertBaseline(backup, oldManifest, io);
  // An interrupted atomic replacement leaves either the old or new file. Preserve unexpected edits.
  for (const name of [...UI_FILES, MANIFEST]) {
    const target = safePath(desktopDir, name, io);
    if (!io.existsSync(target)) throw new Error('更新文件缺失，请保留备份并修复安装');
    const currentHash = hash(io.readFileSync(target));
    const oldHash = name === MANIFEST ? journal.previousManifestHash : oldManifest.files[name];
    const newHash = name === MANIFEST ? journal.nextManifestHash : journal.nextFiles[name];
    if (currentHash !== oldHash && currentHash !== newHash) throw new Error('更新后的文件另有修改，已停止自动恢复；本机备份已保留');
  }
  for (const name of UI_FILES) atomicWrite(desktopDir, name, io.readFileSync(safePath(backup, name, io)), io);
  atomicWrite(desktopDir, MANIFEST, oldManifestBytes, io);
  io.unlinkSync(journalPath);
  return true;
}

function createUpdateService({ desktopDir, repo, hostVersion, fetchImpl = globalThis.fetch, git, now = Date.now, io = fs, kernelOnly = false }) {
  if (!validVersion(hostVersion)) throw new Error('桌面主程序版本无效');
  const runGit = git || (args => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repo, env: { ...cleanEnvironment(process.env), GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024, encoding: 'utf8' },
      (error, stdout) => error ? reject(new Error('无法读取官方源码版本，请检查 Git 和安装目录')) : resolve(stdout.trim()));
  }));
  let state = { checkedAt: null, kernel: { current: '', latest: '', available: false, status: 'unknown' }, ui: { current: '', latest: '', available: false, status: 'unknown' } };
  try { state.ui.current = localManifest(desktopDir, io).version; } catch { /* check() reports an unreadable local manifest. */ }
  let pending = null, installing = false;
  const snapshot = () => {
    const result = structuredClone(state);
    if (io.existsSync(path.join(desktopDir, 'update-incomplete'))) {
      const blocked = result.kernel.status === 'blocked';
      result.kernel = { ...result.kernel, available: true, status: blocked ? 'blocked' : 'error',
        error: '上次官方内核更新未完成，请点击更新官方内核重试。' + (blocked ? ` ${result.kernel.error}` : '') };
    }
    return result;
  };

  async function download(url, limit = 256 * 1024) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TradingAgents-Desktop-Update' } });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? '版本服务暂时限流，请稍后重试' : `版本检查请求失败（HTTP ${response.status}）`);
      if (Number(response.headers.get('content-length')) > limit) throw new Error('更新文件超过允许大小');
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); throw new Error('更新文件超过允许大小'); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error.name === 'AbortError' || controller.signal.aborted) throw new Error('版本检查超时，请检查网络后重试');
      if (/版本|更新文件/.test(error.message)) throw error;
      throw new Error('无法连接版本服务，请检查网络后重试');
    } finally { clearTimeout(timer); }
  }
  async function json(url) {
    try { return JSON.parse((await download(url)).toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('版本服务返回了无效数据'); throw error; }
  }
  const rawUrl = (sha, file) => `https://raw.githubusercontent.com/${UI_REPO}/${sha}/desktop/${file}`;

  async function inspectKernel() {
    const [origin, branch, currentSha, label] = await Promise.all([
      runGit(['remote', 'get-url', 'origin']), runGit(['branch', '--show-current']), runGit(['rev-parse', 'HEAD']), runGit(['describe', '--tags', '--always']),
    ]);
    const current = label;
    state.kernel.current = current;
    if (origin !== OFFICIAL || branch !== 'main' || !validSha(currentSha)) return { current, latest: '', available: false, status: 'blocked', error: '官方源码目录需要使用官方 origin 和 main 分支' };
    const latest = (await json(`${API}TauricResearch/TradingAgents/git/ref/heads/main`)).object?.sha;
    if (!validSha(latest)) throw new Error('官方版本信息无效');
    const base = { current, latest: latest.slice(0, 7), available: false, status: 'current' };
    if (currentSha === latest) return base;
    const comparison = await json(`${API}TauricResearch/TradingAgents/compare/${currentSha}...${latest}?per_page=1&page=2`);
    if (comparison.status === 'ahead' && comparison.ahead_by > 0) return { ...base, available: true, status: 'available' };
    if (comparison.status === 'behind' || comparison.status === 'identical') return base;
    return { ...base, status: 'blocked', error: '本机与官方版本已分叉，请先处理本地提交' };
  }

  async function inspectUi() {
    const installed = localManifest(desktopDir, io);
    const commits = await json(`${API}${UI_REPO}/commits?path=desktop/ui-release.json&sha=main&per_page=1`);
    const sha = Array.isArray(commits) ? commits[0]?.sha : null;
    if (!validSha(sha)) throw new Error('尚未找到已发布的界面版本');
    const bytes = await download(rawUrl(sha, MANIFEST), 64 * 1024);
    const manifest = parseManifest(bytes);
    const available = compareVersions(manifest.version, installed.version) > 0;
    const result = { current: installed.version, latest: manifest.version, available, status: available ? 'available' : 'current' };
    if (manifest.hostVersion !== hostVersion && available) Object.assign(result, { status: 'blocked', error: '此界面版本需要新版桌面主程序，请从项目安装说明升级完整桌面程序' });
    return { result, manifest, bytes, sha, installed };
  }

  async function check({ force = false } = {}) {
    if (installing) return snapshot();
    if (pending) return pending;
    if (!force && state.checkedAt !== null && now() - state.checkedAt < TTL) return snapshot();
    pending = (async () => {
      const names = kernelOnly ? ['kernel'] : ['kernel', 'ui'];
      const results = await Promise.allSettled(kernelOnly ? [inspectKernel()] : [inspectKernel(), inspectUi()]);
      for (const [index, name] of names.entries()) {
        const item = results[index];
        state[name] = item.status === 'fulfilled' ? (name === 'ui' ? item.value.result : item.value) : { ...state[name], status: 'error', error: item.reason.message };
      }
      state.checkedAt = now();
      return snapshot();
    })().finally(() => { pending = null; });
    return pending;
  }

  async function installUi() {
    if (installing) throw new Error('界面更新正在进行');
    installing = true;
    try {
      if (pending) await pending;
      recoverUiUpdate(desktopDir, io);
      const release = await inspectUi();
      state.ui = release.result;
      if (release.result.status === 'blocked') throw new Error(release.result.error);
      if (!release.result.available) return '界面已是最新版本';
      assertBaseline(desktopDir, release.installed, io);
      const files = {};
      for (const name of UI_FILES) {
        const bytes = await download(rawUrl(release.sha, name), 2 * 1024 * 1024);
        if (hash(bytes) !== release.manifest.files[name]) throw new Error('下载的界面文件校验失败，未更改本机文件');
        files[name] = bytes;
      }
      assertBaseline(desktopDir, release.installed, io);
      const oldManifestBytes = io.readFileSync(safePath(desktopDir, MANIFEST, io));
      if (JSON.stringify(parseManifest(oldManifestBytes)) !== JSON.stringify(release.installed)) throw new Error('界面版本在更新期间发生变化，请重新检查');
      const backupId = crypto.randomUUID();
      const backup = safePath(desktopDir, `local-data/ui-update-backups/${backupId}`, io);
      io.mkdirSync(backup, { recursive: true });
      for (const name of [...UI_FILES, MANIFEST]) io.copyFileSync(safePath(desktopDir, name, io), safePath(backup, name, io), fs.constants.COPYFILE_EXCL);
      assertBaseline(backup, release.installed, io);
      if (hash(io.readFileSync(safePath(backup, MANIFEST, io))) !== hash(oldManifestBytes)) throw new Error('备份版本校验失败，未更改本机文件');
      const journal = { schema: 1, backupId, previousManifestHash: hash(oldManifestBytes), nextManifestHash: hash(release.bytes), nextFiles: release.manifest.files };
      atomicWrite(desktopDir, JOURNAL, Buffer.from(JSON.stringify(journal)), io);
      try {
        for (const name of UI_FILES) atomicWrite(desktopDir, name, files[name], io);
        atomicWrite(desktopDir, MANIFEST, release.bytes, io);
        io.unlinkSync(safePath(desktopDir, JOURNAL, io));
      } catch {
        try { recoverUiUpdate(desktopDir, io); }
        catch { throw new Error('界面更新中断，自动恢复未完成；请重新启动以恢复，备份已保留'); }
        throw new Error('界面更新失败，已恢复原版本；备份已保留');
      }
      state.ui = { current: release.manifest.version, latest: release.manifest.version, available: false, status: 'current' };
      state.checkedAt = now();
      return `界面已更新至 ${release.manifest.version}，重新加载后生效`;
    } finally { installing = false; }
  }

  return { check, installUi };
}

module.exports = { createUpdateService, recoverUiUpdate, UI_FILES, parseManifest };
