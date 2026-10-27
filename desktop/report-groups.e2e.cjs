// Run with Playwright installed and READER_BROWSER_EXECUTABLE set if needed.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER_EXECUTABLE ? { executablePath: process.env.READER_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const external = [];
    page.on('request', request => { if (/^https?:/i.test(request.url())) external.push(request.url()); });
    await page.addInitScript(() => {
      window.desktop = {
        onLog() {}, onStopError() {}, profiles: async () => ({ profiles: [{ id: 'model', name: 'Test', model: 'model' }], selectedId: 'model' }),
        reportsList: async () => [
          { id: 'new-1', ticker: 'NVDA', date: '2026-10-27', title: '研究示例 · run-20261027-123456' },
          { id: 'old', ticker: 'AAPL', date: '2025-02-03', title: '较早的报告' },
          { id: 'new-2', ticker: 'MSFT', date: '2026-10-27', title: '当天第二份报告' },
          { id: 'bad', ticker: 'OLD', date: '2026-02-30', title: '未分类报告' },
          { id: 'middle', ticker: 'GOOG', date: '2026-10-26', title: '前一天的报告' },
        ],
        readReport: async () => ({ title: '研究示例', text: '# Trading Analysis Report: NVDA\n\n## I. Analyst Team Reports\n\n### Market Analyst\n研究内容。\n\n## V. Portfolio Manager Decision\n\n### Portfolio Manager\n**Rating**: Overweight\n\n建议等待更多确认，并关注风险。' }),
        run: async () => ({ code: 0, reportId: 'middle', stopped: false }),
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.click('[data-page=reader]');
    await page.waitForSelector('.report-date-group');
    assert.deepEqual(await page.locator('.report-date-label').allTextContents(), ['2026-10-27', '2026-10-26', '2025-02-03', '未分类']);
    assert.deepEqual(await page.locator('.report-date-group').first().locator('.report-item strong').allTextContents(), ['NVDA', 'MSFT']);
    assert.equal(await page.locator('.report-date-group').first().getAttribute('open'), '');
    assert.equal(await page.locator('.report-date-group').nth(1).getAttribute('open'), null);
    await page.locator('.report-date-group').nth(1).locator('summary').click();
    await page.getByRole('button', { name: /GOOG/ }).click();
    assert.equal(await page.getByRole('button', { name: /GOOG/ }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.report-date-group').nth(1).getAttribute('open'), '');
    await page.fill('#report-search', 'AAPL');
    assert.deepEqual(await page.locator('.report-date-label').allTextContents(), ['2025-02-03']);
    assert.equal(await page.getByRole('button', { name: /AAPL/ }).isVisible(), true);
    await page.fill('#report-search', '');
    assert.equal(await page.locator('.report-date-group').nth(1).getAttribute('open'), '');
    assert.equal(await page.getByRole('button', { name: /GOOG/ }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: /NVDA/ }).click();
    await page.waitForSelector('.report-decision-content');
    if (process.env.REPORT_PREVIEW_PATH) await page.screenshot({ path: process.env.REPORT_PREVIEW_PATH });
    await page.locator('.report-date-group').nth(1).locator('summary').click();
    assert.equal(await page.locator('.report-date-group').nth(1).getAttribute('open'), null);
    await page.click('[data-page=analysis]');
    await page.waitForFunction(() => document.querySelector('#active-profile').value === 'model');
    await page.click('#run');
    await page.waitForSelector('#open-latest:not([hidden])');
    await page.click('#open-latest');
    await page.waitForFunction(() => document.querySelector('#page-title').textContent === '报告阅读' && document.querySelector('.report-item.selected strong')?.textContent === 'GOOG');
    assert.equal(await page.locator('.report-date-group').nth(1).getAttribute('open'), '');
    assert.equal(await page.getByRole('button', { name: /GOOG/ }).isVisible(), true);
    for (const width of [780, 1050, 1440, 1760]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await page.evaluate(() => {
        const list = document.querySelector('.reader-list').getBoundingClientRect();
        const item = document.querySelector('.report-item').getBoundingClientRect();
        return { outer: document.documentElement.scrollWidth, width: window.innerWidth, itemRight: item.right, listRight: list.right };
      });
      assert.ok(box.outer <= box.width, `horizontal overflow at ${width}`);
      assert.ok(box.itemRight <= box.listRight, `item overflow at ${width}`);
    }
    assert.deepEqual(external, []);
    console.log('Report groups passed: descending dates, stable same-day order, invalid date, expansion, search, selection, layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
