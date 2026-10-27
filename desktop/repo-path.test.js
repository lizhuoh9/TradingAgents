const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { officialRepoPath } = require('./repo-path');

test('finds an independent official checkout in both supported layouts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-repo-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const official = path.join(root, 'TradingAgents');
  const python = path.join(official, '.venv-win', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(python), { recursive: true }); fs.writeFileSync(python, '');
  const siblingDesktop = path.join(root, 'TradingAgents-Desktop'); fs.mkdirSync(siblingDesktop);
  assert.equal(officialRepoPath(siblingDesktop, {}), official);
  const fork = path.join(root, 'fork'); const embeddedDesktop = path.join(fork, 'desktop');
  fs.mkdirSync(embeddedDesktop, { recursive: true }); fs.mkdirSync(path.join(fork, 'tradingagents')); fs.writeFileSync(path.join(fork, 'pyproject.toml'), '');
  assert.equal(officialRepoPath(embeddedDesktop, {}), official);
  assert.equal(officialRepoPath(embeddedDesktop, { TRADINGAGENTS_SOURCE_DIR: official }), official);
  assert.throws(() => officialRepoPath(embeddedDesktop, { TRADINGAGENTS_SOURCE_DIR: fork }), /不能与桌面项目所在仓库相同/);
});
