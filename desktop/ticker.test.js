const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./validate');

test('six-digit symbols require a market suffix', () => {
  const date = '2026-10-27';
  assert.throws(() => validate({ ticker: '600172', date }), /市场后缀/);
  for (const ticker of ['600172.SS', '000001.SZ', '005930.KS', 'AAPL']) {
    assert.doesNotThrow(() => validate({ ticker, date }));
  }
});
