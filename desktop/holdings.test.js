const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHoldingsStore } = require('./holdings-store');
const { createWatchlistStore } = require('./watchlist-store');

test('holdings persist separately from watchlist and require explicit additions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'holdings.json');
  const holdings = createHoldingsStore(file);
  const watchlist = createWatchlistStore(path.join(dir, 'watchlist.json'));
  watchlist.add({ ticker: 'MSFT' });
  assert.deepEqual(holdings.list(), []);
  assert.deepEqual(holdings.add({ ticker: ' 600172.ss ', name: '黄河旋风' }), [{ ticker: '600172.SS', name: '黄河旋风' }]);
  assert.equal(holdings.add({ ticker: '600172.SS' }).length, 1);
  assert.deepEqual(createHoldingsStore(file).list(), [{ ticker: '600172.SS', name: '黄河旋风' }]);
  assert.throws(() => holdings.add({ ticker: '600172' }), /市场后缀/);
  assert.deepEqual(holdings.remove('600172.SS'), []);
  assert.deepEqual(watchlist.list(), [{ ticker: 'MSFT', name: '' }]);
});

test('unreadable holdings are not overwritten', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'holdings.json');
  fs.writeFileSync(file, '{broken');
  const holdings = createHoldingsStore(file);
  assert.throws(() => holdings.add({ ticker: 'AAPL' }), /持仓.*未更改/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
