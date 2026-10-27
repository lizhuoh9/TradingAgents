const fs = require('node:fs');
const path = require('node:path');

// Keep the application checkout separate from the official checkout so updating
// the official main branch remains a fast-forward operation.
function officialRepoPath(desktopDir, env = process.env) {
  const parent = path.resolve(desktopDir, '..');
  const embedded = fs.existsSync(path.join(parent, 'tradingagents')) && fs.existsSync(path.join(parent, 'pyproject.toml'));
  const candidates = env.TRADINGAGENTS_SOURCE_DIR
    ? [path.resolve(env.TRADINGAGENTS_SOURCE_DIR)]
    : embedded
      ? [path.resolve(parent, '..', 'TradingAgents')]
      : [path.resolve(parent, 'TradingAgents'), path.resolve(parent, '..', 'TradingAgents')];
  const repo = candidates.find(candidate => fs.existsSync(path.join(candidate, '.venv-win', 'Scripts', 'python.exe'))) || candidates[0];
  const real = target => fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
  if (embedded && real(repo) === real(parent)) throw new Error('官方源码目录不能与桌面项目所在仓库相同，请使用独立的官方源码目录');
  return repo;
}

module.exports = { officialRepoPath };
