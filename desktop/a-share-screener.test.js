const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAShareScreener, parseFinance, parseQuotes, parseTencentRanking, parseTencentQuotes } = require('./a-share-screener');

const epoch = Date.parse('2026-10-28T05:00:00Z') / 1000;
const now = () => Date.parse('2026-10-28T06:00:00Z');
const quote = (code, market, amount, name = 'Example') => ({ f12: code, f13: market, f14: name, f2: 10, f3: 1.2, f6: amount, f8: 3.2, f10: 1.1, f124: epoch });
const finance = (code, profit, reportDate = '2026-06-30', announcementDate = '2026-08-22') => ({ success: true, result: { data: [{ SECURITY_CODE: code, PARENT_NETPROFIT: profit, REPORTDATE: reportDate, NOTICE_DATE: announcementDate, WEIGHTAVG_ROE: 5 }] } });

test('only valid active Shanghai and Shenzhen equities are ranked by turnover', () => {
  const result = parseQuotes({ data: { diff: [quote('600123', 1, 40), quote('000001', 0, 90), quote('300001', 0, 80, '*ST Sample'), quote('830001', 0, 100), quote('600999', 1, 100, '')] } });
  assert.equal(result.marketDate, '2026-10-28');
  assert.deepEqual(result.items.map(x => x.ticker), ['000001.SZ', '600123.SS']);
  assert.throws(() => parseQuotes({ data: { diff: [] } }), /不可用/);
});

test('financial evidence requires matching symbol, reported numeric profit, and prior announcement', () => {
  assert.equal(parseFinance(finance('600123', 23), '600123', '2026-10-28').netProfit, 23);
  assert.equal(parseFinance(finance('600123', 23, '2026-09-30', '2026-11-01'), '600123', '2026-10-28'), null);
  assert.equal(parseFinance(finance('600123', '23'), '600123', '2026-10-28'), null);
  assert.equal(parseFinance(finance('600123', 23), '000001', '2026-10-28'), null);
  const missingLatest = { success: true, result: { data: [
    { SECURITY_CODE: '600123', PARENT_NETPROFIT: null, REPORTDATE: '2026-09-30', NOTICE_DATE: '2026-10-27' },
    { SECURITY_CODE: '600123', PARENT_NETPROFIT: 50, REPORTDATE: '2026-06-30', NOTICE_DATE: '2026-08-22' },
  ] } };
  assert.equal(parseFinance(missingLatest, '600123', '2026-10-28'), null);
  assert.throws(() => parseFinance({ success: false }, '600123', '2026-10-28'));
});

test('screen returns only verified historical profit and marks failures instead of fabricating', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ascreen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'cache.json');
  let active = 0, maxActive = 0;
  const request = async url => {
    const u = new URL(url);
    if (u.hostname === 'push2delay.eastmoney.com') return { data: { diff: [quote('600123', 1, 100), quote('000001', 0, 90), quote('300002', 0, 80)] } };
    assert.equal(u.hostname, 'datacenter-web.eastmoney.com');
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    const code = u.searchParams.get('filter').match(/\d{6}/)[0];
    if (code === '300002') throw new Error('simulated network failure');
    return finance(code, code === '600123' ? 50 : -50);
  };
  const result = await createAShareScreener({ cacheFile, request, now }).screen();
  assert.equal(maxActive, 2);
  assert.equal(result.evaluatedCount, 3);
  assert.equal(result.unknownCount, 1);
  assert.deepEqual(result.candidates.map(x => x.ticker), ['600123.SS']);
  assert.equal(result.candidates[0].profitStatus, 'verified_positive');
  assert.equal(result.candidates[0].reportDate, '2026-06-30');
  assert.equal(result.cached, false);
  assert.match(result.warnings[0], /过去盈利不代表未来收益/);
  const cached = await createAShareScreener({ cacheFile, request: async () => { throw new Error('offline'); }, now }).screen();
  assert.equal(cached.cached, true);
  assert.match(cached.warnings.at(-1), /缓存/);
  const corrupted = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  corrupted.candidates[0].announcementDate = '2026-12-01';
  fs.writeFileSync(cacheFile, JSON.stringify(corrupted));
  await assert.rejects(() => createAShareScreener({ cacheFile, request: async () => { throw new Error('offline'); }, now }).screen(), /不可用/);
  await assert.rejects(() => createAShareScreener({ cacheFile, request: async () => { throw new Error('offline'); }, now: () => now() + 8 * 86400000 }).screen(), /不可用/);
});

test('all missing financial data is an error, not an empty profitable list', async () => {
  const request = async url => new URL(url).hostname === 'push2delay.eastmoney.com'
    ? { data: { diff: [quote('600123', 1, 100)] } } : { success: true, result: { data: [] } };
  await assert.rejects(() => createAShareScreener({ request, now }).screen(), /不可用/);
});

test('future or excessively old market data is rejected, while holiday-age data is flagged', async () => {
  const makeRequest = timestamp => async url => new URL(url).hostname === 'push2delay.eastmoney.com'
    ? { data: { diff: [{ ...quote('600123', 1, 100), f124: timestamp }] } }
    : finance('600123', 50);
  await assert.rejects(() => createAShareScreener({ request: makeRequest(epoch + 86400), now }).screen(), /晚于当前日期/);
  await assert.rejects(() => createAShareScreener({ request: makeRequest(epoch - 32 * 86400), now }).screen(), /超过 31 天/);
  const result = await createAShareScreener({ request: makeRequest(epoch - 8 * 86400), now }).screen();
  assert.equal(result.marketDate, '2026-10-20');
  assert.match(result.warnings.join(' '), /距当前日期 8 天/);
});

test('offline cached results receive a fresh market-age warning', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ascreen-age-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'cache.json');
  const request = async url => new URL(url).hostname === 'push2delay.eastmoney.com'
    ? { data: { diff: [{ ...quote('600123', 1, 100), f124: epoch - 7 * 86400 }] } }
    : finance('600123', 50);
  const original = await createAShareScreener({ cacheFile, request, now }).screen();
  assert.doesNotMatch(original.warnings.join(' '), /距当前日期/);
  const cached = await createAShareScreener({ cacheFile, request: async () => { throw new Error('offline'); }, now: () => now() + 86400000 }).screen();
  assert.equal(cached.cached, true);
  assert.match(cached.warnings.join(' '), /距当前日期 8 天/);
});

const rankItem = (code, amount, name = 'Example') => ({ code, name, zxj: '10.00', zdf: '1.2', hsl: '3.2', lb: '1.1', turnover: amount });
const tencentQuote = (symbol, date, { price = '10', amount = '100', name = 'Example' } = {}) => {
  const fields = Array(50).fill(''); fields[1] = name; fields[2] = symbol.slice(2); fields[3] = price; fields[30] = date + '150000';
  fields[32] = '1.2'; fields[37] = amount; fields[38] = '3.2'; fields[49] = '1.1';
  return `v_${symbol}="${fields.join('~')}";`;
};

test('Tencent fallback requires per-stock timestamp and converts turnover from ten-thousand yuan', () => {
  const ranking = parseTencentRanking({ code: 0, data: { rank_list: [rankItem('sz000001', '90'), rankItem('sh600123', '100'), rankItem('bj830001', '120'), rankItem('sz300002', '110', '*ST Bad')] } });
  assert.deepEqual(ranking.map(row => row.ticker), ['000001.SZ', '600123.SS']);
  assert.equal(ranking[0].turnoverAmount, 900000);
  const result = parseTencentQuotes(tencentQuote('sz000001', '20261027') + tencentQuote('sh600123', '20261028'), ranking);
  assert.equal(result.marketDate, '2026-10-28');
  assert.deepEqual(result.items.map(row => row.ticker), ['600123.SS']);
  assert.throws(() => parseTencentQuotes('not a quote', ranking), /交易日期/);
});

test('failed primary falls back to Tencent and keeps verified disclosed profit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ascreen-tencent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'cache.json');
  const request = async url => {
    const u = new URL(url);
    if (u.hostname === 'push2delay.eastmoney.com') throw new Error('offline');
    if (u.hostname === 'proxy.finance.qq.com') return { code: 0, data: { rank_list: [rankItem('sh600123', '100'), rankItem('sz000001', '90')] } };
    if (u.hostname === 'qt.gtimg.cn') return tencentQuote('sh600123', '20261028') + tencentQuote('sz000001', '20261028');
    if (u.hostname === 'datacenter-web.eastmoney.com') return finance(u.searchParams.get('filter').match(/\d{6}/)[0], 50);
    throw new Error('unexpected destination');
  };
  const result = await createAShareScreener({ request, cacheFile, now }).screen();
  assert.match(result.source, /腾讯/);
  assert.equal(result.marketDate, '2026-10-28');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].turnoverAmount, 1000000);
  assert.match(result.warnings.join(' '), /逐股行情/);
  const cached = await createAShareScreener({ request: async () => { throw new Error('offline'); }, cacheFile, now }).screen();
  assert.equal(cached.cached, true);
  assert.match(cached.source, /腾讯/);
});

test('Tencent uses price and turnover from the dated stock quote, not the older ranking snapshot', () => {
  const ranking = parseTencentRanking({ code: 0, data: { rank_list: [rankItem('sz000001', '9999'), rankItem('sh600123', '1')] } });
  const text = tencentQuote('sz000001', '20261028', { price: '11', amount: '2' })
    + tencentQuote('sh600123', '20261028', { price: '30', amount: '15' });
  const result = parseTencentQuotes(text, ranking);
  assert.deepEqual(result.items.map(row => row.ticker), ['600123.SS', '000001.SZ']);
  assert.equal(result.items[0].price, 30);
  assert.equal(result.items[0].turnoverAmount, 150000);
  assert.equal(result.items[1].price, 11);
  assert.equal(result.items[1].turnoverAmount, 20000);
  assert.equal(result.items[0].marketDate, '2026-10-28');
  assert.equal(result.items[0].turnoverPercent, 3.2);
  assert.equal(result.items[0].volumeRatio, 1.1);
});

test('Tencent excludes a dated quote when its price or turnover is missing', () => {
  const ranking = parseTencentRanking({ code: 0, data: { rank_list: [rankItem('sz000001', '90')] } });
  assert.throws(() => parseTencentQuotes(tencentQuote('sz000001', '20261028', { price: '' }), ranking), /交易日期/);
  assert.throws(() => parseTencentQuotes(tencentQuote('sz000001', '20261028', { amount: '' }), ranking), /交易日期/);
});

test('fallback refuses missing or future trade dates rather than substituting collection date', async () => {
  const request = async url => {
    const u = new URL(url);
    if (u.hostname === 'push2delay.eastmoney.com') throw new Error('offline');
    if (u.hostname === 'proxy.finance.qq.com') return { code: 0, data: { rank_list: [rankItem('sh600123', '100')] } };
    if (u.hostname === 'qt.gtimg.cn') return tencentQuote('sh600123', '20261029');
    throw new Error('unexpected destination');
  };
  await assert.rejects(() => createAShareScreener({ request, now }).screen(), /晚于当前日期/);
  await assert.rejects(() => createAShareScreener({ request: async url => new URL(url).hostname === 'proxy.finance.qq.com' ? { code: 0, data: { rank_list: [rankItem('sh600123', '100')] } } : (new URL(url).hostname === 'qt.gtimg.cn' ? '' : Promise.reject(new Error('offline'))), now }).screen(), /不可用/);
});
