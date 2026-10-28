// Generate a pinned list of runtime files; local data and tests are never shipped.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fileHash, parseManifest } = require('./desktop-update');

const names = [
  '启动桌面版.cmd', 'a-share-screener.js', 'analysis-control.js', 'batch-runner.js',
  'data-key-store.js', 'desktop-launcher.js', 'desktop-update.js', 'environment.js', 'fred_guard.py',
  'holdings-store.js', 'index.html', 'job_supervisor.py', 'latest-queue.js', 'main.js',
  'mask.js', 'memory_commit.py', 'memory_transaction.py', 'model_catalog_bridge.py',
  'model-service.js', 'package-lock.json', 'package.json', 'preload.js', 'profile-store.js',
  'renderer.js', 'repo-path.js', 'report-store.js', 'run_analysis.py', 'strip-control.js',
  'style.css', 'ui-release.json', 'update-service.js', 'validate.js', 'watchlist-store.js',
  'assets/tauric-icon.ico', 'assets/tauric-icon.svg', 'assets/tauric-logo.svg',
  'vendor/cds-pure.css', 'vendor/cds-theme.css', 'vendor/LICENSE-open-claude-ui',
];
const target = path.join(__dirname, 'desktop-release.json');
const manifest = { schema: 1, version: require('./package.json').version, files: Object.fromEntries(names.map(name => [name, fileHash(name, fs.readFileSync(path.join(__dirname, name)))])) };
parseManifest(Buffer.from(JSON.stringify(manifest)));
if (process.argv[2] === '--check') {
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), manifest, '桌面发行清单与当前文件不一致');
  console.log('Desktop release manifest verified.');
} else {
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Desktop release ${manifest.version} prepared.`);
}
