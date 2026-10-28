// Local mock-only UI test; no model, market or credentials are sent anywhere.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER_EXECUTABLE ? { executablePath: process.env.READER_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1050, height: 800 } });
    const external = [];
    page.on('request', request => { if (/^https?:/i.test(request.url())) external.push(request.url()); });
    await page.addInitScript(() => {
      let items = []; let holdings = []; window.__screenCalls = 0; window.__batchArgs = null; window.__singleReport = false; window.__singleFailure = false;
      window.desktop = {
        onLog() {}, onStopError() {}, profiles: async () => ({ profiles: [{ id: 'profile', name: 'Mock', model: 'test' }], selectedId: 'profile' }),
        watchlist: async () => items,
        watchlistAdd: async item => { const ticker = item.ticker.toUpperCase(); if (!items.some(row => row.ticker === ticker)) items = [...items, { ticker, name: item.name || '' }]; return items; },
        watchlistRemove: async ticker => { items = items.filter(row => row.ticker !== ticker); return items; },
        holdings: async () => holdings,
        holdingsAdd: async item => { if (!holdings.some(row => row.ticker === item.ticker.toUpperCase())) holdings = [...holdings, { ticker: item.ticker.toUpperCase(), name: item.name || '' }]; return holdings; },
        holdingsRemove: async ticker => { holdings = holdings.filter(row => row.ticker !== ticker); return holdings; },
        onBatchProgress: callback => { window.__progress = callback; },
        runBatch: input => { window.__batchArgs = input; return new Promise(resolve => { window.__finish = resolve; }); },
        run: async () => { if (window.__singleFailure) return { code: 1, reportId: null, stopped: false }; window.__singleReport = true; return { code: 0, reportId: 'new-report', stopped: false }; },
        stop: async () => ({ requested: true }),
        reportsList: async () => [...(window.__singleReport ? [{ id: 'new-report', ticker: 'AAPL', date: '2026-10-28', title: 'New' }] : []), { id: 'report', ticker: 'AAPL', date: '2026-10-28', title: 'Mock' }],
        readReport: async id => ({ title: 'Mock', text: `# Trading Analysis Report: AAPL\n\n- Rating: ${id === 'new-report' ? 'Sell' : 'Overweight'}\n\n## V. Portfolio Manager Decision\n\n### Portfolio Manager\n**Rating**: ${id === 'new-report' ? 'Sell' : 'Overweight'}\n\nConditions.` }),
        screenAShares: async () => { window.__screenCalls++; return { source: 'Mock source', marketDate: '2026-10-28', fetchedAt: '10:00', candidates: [
          { ticker: '600000.SS', name: '示例甲', profitStatus: 'verified_positive', netProfit: 200000000, reportDate: '2026-06-30', price: 10, turnoverAmount: 100000000 },
          { ticker: '000001.SZ', name: '示例乙', profitStatus: 'unknown', price: 11 },
        ], warnings: [] }; },
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.waitForFunction(() => document.querySelector('#active-profile').value === 'profile');
    await page.click('#screen-home');
    await page.waitForSelector('.screen-item');
    assert.equal(await page.evaluate(() => window.__screenCalls), 1);
    await page.getByRole('button', { name: '选择分析 示例甲' }).click();
    assert.equal(await page.inputValue('#ticker'), '600000.SS');
    assert.equal(await page.evaluate(() => window.__singleReport), false);
    await page.click('.navigation [data-page="holdings"]');
    await page.fill('#holdings-ticker', '600000.SS'); await page.fill('#holdings-name', '示例甲');
    await page.click('#holdings-add-form button');
    await page.waitForFunction(() => document.querySelector('#holdings-total').textContent === '1');
    await page.getByRole('button', { name: '选择分析持仓 600000.SS' }).click();
    assert.equal(await page.inputValue('#ticker'), '600000.SS');
    assert.equal(await page.evaluate(() => window.__singleReport), false);
    await page.click('.navigation [data-page="holdings"]');
    await page.getByRole('button', { name: '移除持仓 600000.SS' }).click();
    await page.waitForFunction(() => document.querySelector('#holdings-total').textContent === '0');
    await page.click('.navigation [data-page="analysis"]');
    await page.click('[data-ticker="AAPL"]');
    await page.click('#run');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('报告已保存'));
    await page.click('.navigation [data-page="watchlist"]');
    await page.waitForFunction(() => document.querySelector('#watch-total').textContent === '0');
    await page.click('.navigation [data-page="analysis"]');
    await page.click('#watch-add-current');
    await page.click('.navigation [data-page="watchlist"]');
    await page.waitForFunction(() => document.querySelector('#watch-total').textContent === '1');
    await page.evaluate(() => { window.__singleReport = false; });
    await page.fill('#watch-ticker', 'MSFT'); await page.click('#watch-add-form button');
    await page.waitForFunction(() => document.querySelector('#watch-total').textContent === '2');
    await page.fill('#watch-ticker', 'MSFT'); await page.click('#watch-add-form button');
    assert.equal(await page.locator('.watch-item').count(), 2);
    await page.click('.navigation [data-page="watchlist"]');
    await page.waitForFunction(() => document.querySelector('.watch-item').textContent.includes('卖出'));
    await page.click('#watch-run');
    assert.deepEqual(await page.evaluate(() => window.__batchArgs.tickers), ['AAPL', 'MSFT']);
    assert.equal(await page.locator('#watch-date').isDisabled(), true);
    assert.match(await page.locator('.watch-item').first().innerText(), /阅读上次报告/);
    await page.evaluate(() => { document.querySelector('#watch-date').value = '2026-11-01'; window.__progress({ ticker: 'AAPL', status: 'failed', code: 1, date: '2026-10-28' }); });
    assert.match(await page.locator('.watch-item').first().innerText(), /阅读上次报告/);
    await page.evaluate(() => window.__progress({ ticker: 'AAPL', status: 'completed', code: 0, reportId: 'report', date: '2026-10-28' }));
    await page.waitForFunction(() => document.querySelector('.watch-item').textContent.includes('偏买 · 增持'));
    assert.match(await page.locator('.watch-item').first().innerText(), /2026-10-28/);
    assert.doesNotMatch(await page.locator('.watch-item').first().innerText(), /2026-11-01/);
    if (process.env.WATCHLIST_SCREENSHOT) await page.screenshot({ path: process.env.WATCHLIST_SCREENSHOT });
    await page.click('#watch-stop');
    assert.match(await page.textContent('#watch-message'), /停止/);
    await page.evaluate(() => window.__finish({ results: [{ ticker: 'AAPL', code: 0, reportId: 'report', stopped: false }, { ticker: 'MSFT', code: null, reportId: null, stopped: true }], stopped: true }));
    await page.waitForFunction(() => document.querySelector('#watch-message').textContent.includes('批次已停止'));
    await page.click('.navigation [data-page="analysis"]');
    await page.fill('#ticker', 'AAPL'); await page.click('#run');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('报告已保存'));
    await page.click('.navigation [data-page="watchlist"]');
    await page.waitForFunction(() => document.querySelector('.watch-item').textContent.includes('卖出'));
    await page.evaluate(() => { window.__singleFailure = true; });
    await page.click('.navigation [data-page="analysis"]'); await page.click('#run');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('运行失败'));
    await page.click('.navigation [data-page="watchlist"]');
    assert.match(await page.locator('.watch-item').first().innerText(), /卖出/);
    await page.getByRole('button', { name: '移除 MSFT' }).click();
    await page.waitForFunction(() => document.querySelector('#watch-total').textContent === '1');
    await page.click('.navigation [data-page="markets"]');
    await page.getByRole('button', { name: /贵州茅台/ }).click();
    await page.click('.navigation [data-page="watchlist"]');
    await page.waitForFunction(() => document.querySelector('#watch-total').textContent === '1');
    await page.click('.navigation [data-page="markets"]');
    assert.equal(await page.evaluate(() => window.__screenCalls), 1);
    await page.click('#screen-ashares');
    await page.waitForSelector('.screen-item');
    assert.match(await page.locator('#screen-results').innerText(), /已披露盈利候选/);
    assert.doesNotMatch(await page.locator('#screen-results').innerText(), /示例乙/);
    assert.match(await page.locator('#screen-status').innerText(), /已排除/);
    assert.equal(await page.evaluate(() => window.__screenCalls), 2);
    const sourceStatus = await page.locator('#screen-status').innerText();
    await page.getByRole('button', { name: /添加 示例甲/ }).click();
    assert.equal(await page.locator('#screen-status').innerText(), sourceStatus);
    await page.click('.navigation [data-page="watchlist"]');
    await page.waitForFunction(() => document.querySelector('#watch-total').textContent === '2');
    for (const width of [780, 1050, 1760]) {
      await page.setViewportSize({ width, height: 800 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(external, []);
    const race = await browser.newPage();
    await race.addInitScript(() => {
      window.desktop = {
        onLog() {}, onStopError() {}, onBatchProgress() {},
        profiles: async () => ({ profiles: [{ id: 'profile', name: 'Test', model: 'test' }], selectedId: 'profile' }),
        watchlist: async () => [{ ticker: 'AAPL', name: '' }],
        reportsList: async () => [{ id: 'old', ticker: 'AAPL', date: '2026-10-27', title: 'Old' }],
        readReport: () => new Promise(resolve => { window.__releaseOld = () => resolve({ text: '# Trading Analysis Report: AAPL\n\n- Rating: Hold' }); }),
        runBatch: () => new Promise(() => {}),
      };
    });
    await race.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await race.click('.navigation [data-page="watchlist"]');
    await race.waitForFunction(() => document.querySelector('.watch-item') && window.__releaseOld);
    await race.click('#watch-run');
    await race.evaluate(() => window.__releaseOld());
    await race.waitForFunction(() => document.querySelector('.watch-item').textContent.includes('阅读上次报告'));
    assert.match(await race.locator('.watch-item').innerText(), /等待分析/);
    await race.close();
    console.log('Watchlist UI passed: add, deduplication, batch status, stop, final rating and explicit candidate screening.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
