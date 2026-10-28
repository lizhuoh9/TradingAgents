const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWatchlistStore, MAX_WATCHLIST } = require('./watchlist-store');

test('watchlist is local, normalized, deduplicated and can remove individual items', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'watchlist.json'); const store = createWatchlistStore(file);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.add({ ticker: ' aapl ', name: 'Apple' }), [{ ticker: 'AAPL', name: 'Apple' }]);
  assert.equal(store.add({ ticker: 'AAPL' }).length, 1);
  store.add({ ticker: '600172.SS', name: '示例' });
  assert.deepEqual(createWatchlistStore(file).list().map(item => item.ticker), ['AAPL', '600172.SS']);
  assert.deepEqual(store.remove('aapl').map(item => item.ticker), ['600172.SS']);
  assert.throws(() => store.add({ ticker: '600172' }), /市场后缀/);
  assert.throws(() => store.add({ ticker: '../secret' }), /股票代码/);
  assert.throws(() => store.add({ ticker: 'MSFT', name: '\u0000x' }), /股票名称/);
  const items = Array.from({ length: MAX_WATCHLIST }, (_, n) => ({ ticker: `T${n}`, name: '' }));
  fs.writeFileSync(file, JSON.stringify(items));
  assert.throws(() => store.add({ ticker: 'EXTRA' }), /最多/);
});

test('an unreadable watchlist is never overwritten', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'watchlist.json'); fs.writeFileSync(file, '{broken');
  const store = createWatchlistStore(file);
  assert.throws(() => store.add({ ticker: 'AAPL' }), /未更改/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('only the first visit imports valid completed report tickers', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'watchlist.json'); const store = createWatchlistStore(file);
  const reports = [ { ticker: 'aapl' }, { ticker: 'AAPL' }, { ticker: '600172.SS' }, { ticker: '600172' }, { ticker: '' } ];
  assert.deepEqual(store.initialize(() => reports).map(item => item.ticker), ['AAPL', '600172.SS']);
  store.remove('AAPL'); store.remove('600172.SS');
  assert.deepEqual(store.initialize(() => { throw new Error('must not re-import'); }), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
});
