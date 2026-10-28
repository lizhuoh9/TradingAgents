// Frozen startup recovery protocol. Changing this file requires a full manual upgrade.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST = 'desktop-release.json';
const JOURNAL = 'local-data/desktop-update-pending.json';
const REPO = 'lizhuoh9/TradingAgents';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fileHash(name, bytes) {
  if (!/\.(?:c?js|py|json|html|css|svg|cmd)$/i.test(name) && !name.endsWith('LICENSE-open-claude-ui')) return hash(bytes);
  const normalized = Buffer.allocUnsafe(bytes.length); let end = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 13 || bytes[i + 1] !== 10) normalized[end++] = bytes[i];
  return hash(normalized.subarray(0, end));
}
function allowed(name) {
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)) return false;
  return /^(?:[a-z][a-z0-9_-]*\.(?:c?js|py)|(?:package(?:-lock)?|ui-release)\.json|index\.html|style\.css)$/.test(name)
    || name === '启动桌面版.cmd' || /^assets\/[a-z0-9-]+\.(?:svg|ico|png|jpe?g|webp)$/.test(name)
    || /^vendor\/(?:cds-pure\.css|cds-theme\.css|LICENSE-open-claude-ui)$/.test(name);
}
function safePath(root, name, io = fs) {
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) throw new Error('桌面更新路径无效');
  let result = path.resolve(root);
  for (const part of ['', ...parts]) {
    if (part) result = path.join(result, part);
    try { if (io.lstatSync(result).isSymbolicLink()) throw new Error('更新路径包含链接，已停止更新'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
function atomicWrite(root, name, bytes, io = fs) {
  const target = safePath(root, name, io), temp = `${target}.update-${crypto.randomUUID()}`;
  io.mkdirSync(path.dirname(target), { recursive: true });
  try { io.writeFileSync(temp, bytes, { flag: 'wx' }); io.renameSync(temp, target); }
  finally { if (io.existsSync(temp)) io.unlinkSync(temp); }
}
function atomicCreate(root, name, bytes, backupId, io = fs) {
  const target = safePath(root, name, io), marker = safePath(root, `${name}.desktop-update-${backupId}`, io);
  const temp = `${marker}.tmp-${crypto.randomUUID()}`;
  io.mkdirSync(path.dirname(target), { recursive: true });
  try { io.writeFileSync(temp, bytes, { flag: 'wx' }); io.linkSync(temp, marker); }
  finally { if (io.existsSync(temp)) io.unlinkSync(temp); }
  io.linkSync(marker, target);
}
function parseManifest(bytes) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('桌面版本清单无法读取'); }
  if (!data || data.schema !== 1 || !VERSION.test(data.version || '') || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) throw new Error('桌面版本清单无效');
  const names = Object.keys(data.files);
  if (!names.length || names.length > 100 || names.some(name => !allowed(name) || !HASH.test(data.files[name])) ||
      !['desktop-launcher.js', 'desktop-update.js', 'main.js', 'package.json', 'package-lock.json', 'index.html', 'renderer.js', 'style.css', 'ui-release.json'].every(name => names.includes(name))) throw new Error('桌面版本清单包含无效文件');
  return data;
}
function assertBaseline(root, manifest, io = fs) {
  for (const [name, digest] of Object.entries(manifest.files)) {
    const target = safePath(root, name, io);
    if (!io.existsSync(target) || fileHash(name, io.readFileSync(target)) !== digest) throw new Error(`桌面文件有本地修改或缺失：${name}，未覆盖文件`);
  }
}
function validateDependencies(oldPackage, newPackage, oldLock, newLock) {
  let a, b, c, d;
  try { a = JSON.parse(oldPackage); b = JSON.parse(newPackage); c = JSON.parse(oldLock); d = JSON.parse(newLock); }
  catch { throw new Error('依赖清单无法读取，需要完整手动升级'); }
  const keys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'engines', 'overrides'];
  if (a.main !== 'desktop-launcher.js' || b.main !== 'desktop-launcher.js' || keys.some(key => JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null))) throw new Error('新版依赖或启动方式发生变化，需要完整手动升级');
  for (const lock of [c, d]) { delete lock.version; if (lock.packages?.['']) delete lock.packages[''].version; }
  if (JSON.stringify(c) !== JSON.stringify(d)) throw new Error('新版依赖锁文件发生变化，需要完整手动升级');
}
function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
function recoverDesktopUpdate(root, io = fs) {
  const journalPath = safePath(root, JOURNAL, io);
  if (!io.existsSync(journalPath)) return false;
  let journal;
  try { journal = JSON.parse(io.readFileSync(journalPath, 'utf8')); } catch { throw new Error('桌面更新恢复记录损坏，请保留备份'); }
  if (journal?.schema !== 1 || !/^[a-f0-9-]{36}$/.test(journal.backupId || '') || !HASH.test(journal.oldManifestHash || '') || !HASH.test(journal.newManifestHash || '')) throw new Error('桌面更新恢复记录无效');
  const backup = safePath(root, `local-data/desktop-update-backups/${journal.backupId}`, io);
  const oldBytes = io.readFileSync(safePath(backup, MANIFEST, io));
  const newBytes = io.readFileSync(safePath(backup, 'next-desktop-release.json', io));
  if (hash(oldBytes) !== journal.oldManifestHash || hash(newBytes) !== journal.newManifestHash) throw new Error('桌面更新备份校验失败');
  const oldManifest = parseManifest(oldBytes), next = parseManifest(newBytes);
  if (Object.keys(oldManifest.files).some(name => !next.files[name])) throw new Error('桌面更新恢复记录无效');
  assertBaseline(backup, oldManifest, io);
  for (const name of Object.keys(next.files)) {
    const target = safePath(root, name, io);
    if (!io.existsSync(target)) { if (oldManifest.files[name]) throw new Error('桌面更新文件缺失，请保留备份'); continue; }
    const digest = fileHash(name, io.readFileSync(target));
    if (digest !== oldManifest.files[name] && digest !== next.files[name]) throw new Error(`桌面更新文件另有修改：${name}，已停止自动恢复`);
    if (!oldManifest.files[name]) {
      const marker = safePath(root, `${name}.desktop-update-${journal.backupId}`, io);
      if (!io.existsSync(marker)) throw new Error(`无法确认新增文件的来源：${name}，已停止自动恢复`);
      const a = io.statSync(target), b = io.statSync(marker);
      if (!a.ino || a.ino !== b.ino || a.dev !== b.dev) throw new Error(`新增文件另有修改：${name}，已停止自动恢复`);
    }
  }
  const liveManifest = safePath(root, MANIFEST, io);
  if (!io.existsSync(liveManifest) || ![journal.oldManifestHash, journal.newManifestHash].includes(hash(io.readFileSync(liveManifest)))) throw new Error('桌面版本清单另有修改，已停止自动恢复');
  for (const name of Object.keys(next.files)) {
    if (oldManifest.files[name]) atomicWrite(root, name, io.readFileSync(safePath(backup, name, io)), io);
    else {
      const target = safePath(root, name, io), marker = safePath(root, `${name}.desktop-update-${journal.backupId}`, io);
      if (io.existsSync(target)) io.unlinkSync(target);
      if (io.existsSync(marker)) {
        if (fileHash(name, io.readFileSync(marker)) !== next.files[name]) throw new Error(`更新临时文件另有修改：${name}`);
        io.unlinkSync(marker);
      }
    }
  }
  atomicWrite(root, MANIFEST, oldBytes, io);
  io.unlinkSync(journalPath);
  return true;
}

function createDesktopUpdater({ desktopDir, fetchImpl = globalThis.fetch, io = fs } = {}) {
  let installing = false;
  async function download(url, limit = 2 * 1024 * 1024) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TradingAgents-Desktop-Update' } });
      if (!response.ok) throw new Error(`版本服务请求失败（HTTP ${response.status}）`);
      if (Number(response.headers.get('content-length')) > limit) throw new Error('更新文件过大');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new Error('更新文件过大'); } chunks.push(Buffer.from(value)); }
      return Buffer.concat(chunks);
    } catch (error) { if (controller.signal.aborted) throw new Error('版本服务请求超时'); throw error; }
    finally { clearTimeout(timer); }
  }
  const raw = (sha, name) => `https://raw.githubusercontent.com/${REPO}/${sha}/desktop/${name}`;
  async function inspect() {
    const oldBytes = io.readFileSync(safePath(desktopDir, MANIFEST, io)); const current = parseManifest(oldBytes);
    const commits = JSON.parse((await download(`https://api.github.com/repos/${REPO}/commits?path=desktop/${MANIFEST}&sha=main&per_page=1`, 65536)).toString('utf8'));
    const sha = commits?.[0]?.sha;
    if (!SHA.test(sha || '')) throw new Error('桌面版本信息无效');
    const bytes = await download(raw(sha, MANIFEST), 65536); const next = parseManifest(bytes);
    const available = compareVersions(next.version, current.version) > 0;
    const result = { current: current.version, latest: next.version, available, status: available ? 'available' : 'current' };
    if (available && (['desktop-launcher.js', 'desktop-update.js'].some(name => next.files[name] !== current.files[name]) || Object.keys(current.files).some(name => !next.files[name]))) Object.assign(result, { status: 'blocked', error: '新版需要完整手动升级桌面程序' });
    return { oldBytes, current, bytes, next, sha, result };
  }
  async function check() { return (await inspect()).result; }
  async function install() {
    if (installing) throw new Error('桌面更新正在进行');
    installing = true;
    try {
      if (io.existsSync(safePath(desktopDir, JOURNAL, io))) throw new Error('上次桌面更新未完成，请关闭并重启程序以恢复');
      const release = await inspect();
      if (release.result.status === 'blocked') throw new Error(release.result.error);
      if (!release.result.available) return { installed: false, version: release.current.version };
      assertBaseline(desktopDir, release.current, io);
      const files = {}, entries = Object.entries(release.next.files);
      for (const [name] of entries) {
        if (!release.current.files[name] && io.existsSync(safePath(desktopDir, name, io))) throw new Error(`发现本地文件 ${name}，未覆盖文件`);
      }
      let index = 0, total = 0;
      await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (index < entries.length) {
          const [name, digest] = entries[index++];
          const bytes = await download(raw(release.sha, name));
          total += bytes.length;
          if (total > 16 * 1024 * 1024) throw new Error('桌面更新内容过大');
          if (fileHash(name, bytes) !== digest) throw new Error(`下载文件校验失败：${name}`);
          files[name] = bytes;
        }
      }));
      validateDependencies(io.readFileSync(safePath(desktopDir, 'package.json', io)), files['package.json'], io.readFileSync(safePath(desktopDir, 'package-lock.json', io)), files['package-lock.json']);
      assertBaseline(desktopDir, release.current, io);
      if (hash(io.readFileSync(safePath(desktopDir, MANIFEST, io))) !== hash(release.oldBytes)) throw new Error('本机桌面版本在更新期间发生变化');
      for (const name of Object.keys(release.next.files)) if (!release.current.files[name] && io.existsSync(safePath(desktopDir, name, io))) throw new Error(`发现本地文件 ${name}，未覆盖文件`);
      const backupId = crypto.randomUUID(), backup = safePath(desktopDir, `local-data/desktop-update-backups/${backupId}`, io);
      io.mkdirSync(backup, { recursive: true });
      for (const name of Object.keys(release.current.files)) {
        const dest = safePath(backup, name, io); io.mkdirSync(path.dirname(dest), { recursive: true });
        io.copyFileSync(safePath(desktopDir, name, io), dest, fs.constants.COPYFILE_EXCL);
      }
      assertBaseline(backup, release.current, io);
      assertBaseline(desktopDir, release.current, io);
      if (hash(io.readFileSync(safePath(desktopDir, MANIFEST, io))) !== hash(release.oldBytes)) throw new Error('本机桌面版本在更新期间发生变化');
      io.writeFileSync(safePath(backup, MANIFEST, io), release.oldBytes, { flag: 'wx' });
      io.writeFileSync(safePath(backup, 'next-desktop-release.json', io), release.bytes, { flag: 'wx' });
      const journal = { schema: 1, backupId, oldManifestHash: hash(release.oldBytes), newManifestHash: hash(release.bytes) };
      atomicWrite(desktopDir, JOURNAL, Buffer.from(JSON.stringify(journal)), io);
      try {
        for (const name of Object.keys(release.next.files)) if (!['desktop-launcher.js', 'desktop-update.js'].includes(name)) {
          const target = safePath(desktopDir, name, io);
          if (release.current.files[name]) {
            if (!io.existsSync(target) || fileHash(name, io.readFileSync(target)) !== release.current.files[name]) throw new Error('本机文件在更新期间发生变化');
          } else if (io.existsSync(target)) throw new Error('本机文件在更新期间发生变化');
          if (release.current.files[name]) atomicWrite(desktopDir, name, files[name], io);
          else atomicCreate(desktopDir, name, files[name], backupId, io);
        }
        if (hash(io.readFileSync(safePath(desktopDir, MANIFEST, io))) !== hash(release.oldBytes)) throw new Error('本机桌面版本在更新期间发生变化');
        atomicWrite(desktopDir, MANIFEST, release.bytes, io);
        io.unlinkSync(safePath(desktopDir, JOURNAL, io));
        for (const name of Object.keys(release.next.files)) if (!release.current.files[name]) {
          const marker = safePath(desktopDir, `${name}.desktop-update-${backupId}`, io);
          try { if (io.existsSync(marker)) io.unlinkSync(marker); } catch { /* A stale marker does not change the installed files. */ }
        }
      } catch {
        try { recoverDesktopUpdate(desktopDir, io); }
        catch { throw new Error('桌面更新中断，自动恢复未完成；请重启并保留备份'); }
        throw new Error('桌面更新失败，已恢复原版本');
      }
      return { installed: true, version: release.next.version };
    } finally { installing = false; }
  }
  return { check, install };
}

module.exports = { createDesktopUpdater, recoverDesktopUpdate, parseManifest, fileHash, allowed };
