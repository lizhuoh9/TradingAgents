// Run with Playwright installed and READER_BROWSER_EXECUTABLE set if needed.
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
      window.__reportText = '';
      window.desktop = {
        onLog() {}, onStopError() {}, profiles: async () => ({ profiles: [], selectedId: null }),
        reportsList: async () => [{ id: 'test', ticker: 'TEST', date: '2026-10-27', title: '示例' }],
        readReport: async () => ({ title: '示例', text: window.__reportText }),
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.click('[data-page=reader]');
    await page.waitForSelector('.report-item');
    async function render(text) {
      await page.evaluate(value => { window.__reportText = value; }, text);
      await page.click('.report-item');
      await page.waitForFunction(() => !document.querySelector('#reader-document').hidden);
    }
    const report = (header, body) => `# Trading Analysis Report: TEST\n\n${header}\n\n## I. Analyst Team Reports\n\n### Analyst\n**Rating**: Sell\n\n## V. Portfolio Manager Decision\n\n### Portfolio Manager\n${body}`;
    for (const [raw, label] of [['Buy', '买入'], ['Overweight', '偏买 · 增持'], ['Hold', '持有 / 观望'], ['Underweight', '偏卖 · 减持'], ['Sell', '卖出'], ['REVIEW', '需要复核']]) {
      await render(report(`- Rating: ${raw}`, `**Rating**: ${raw}\n\n条件和风险。`));
      assert.equal(await page.locator('.report-rating-title').innerText(), label);
      assert.match(await page.locator('.report-rating-original').innerText(), new RegExp(raw, 'i'));
      assert.match(await page.locator('.report-decision-content').innerText(), /条件和风险/);
      if (raw === 'Overweight') assert.match(await page.locator('.report-rating-detail').innerText(), /时机和仓位/);
    }
    await render(report('', '**Rating**: Overweight\n\n保留条件。'));
    assert.equal(await page.locator('.report-rating-title').innerText(), '偏买 · 增持');
    await render(report('- Rating: Hold', '**Rating**: Overweight'));
    assert.equal(await page.locator('.report-rating-title').innerText(), '评级不一致，需要复核');
    await render(report('- Rating: Hold', '**Rating**: Overweight\n**Executive Summary**: Test.'));
    assert.equal(await page.locator('.report-rating-title').innerText(), '评级不一致，需要复核');
    await render(report('', '**Rating**: Overweight\n**Executive Summary**: Test.'));
    assert.equal(await page.locator('.report-rating-title').innerText(), '偏买 · 增持');
    await render(report('- Rating: Buy', '- **Rating**: Sell\n- Other details'));
    assert.equal(await page.locator('.report-rating-title').innerText(), '评级不一致，需要复核');
    await render(report('', '- **Rating**: Sell\n- Other details'));
    assert.equal(await page.locator('.report-rating-title').innerText(), '卖出');
    await render(report('', '- Other details\n- **Rating**: Sell'));
    assert.equal(await page.locator('.report-rating-title').innerText(), '未识别最终评级');
    await render(report('- Rating: Buy\n- Rating: Sell', '**Rating**: Buy'));
    assert.equal(await page.locator('.report-rating-title').innerText(), '评级不一致，需要复核');
    await render(report('- Rating: Surprise<script>alert(1)</script>', '**Executive Summary**: No recommendation.'));
    assert.equal(await page.locator('.report-rating-title').innerText(), '未识别最终评级');
    assert.equal(await page.locator('.report-rating script').count(), 0);
    await render('# Trading Analysis Report: TEST\n\n## III. Trading Team Plan\n\n### Trader\n**Rating**: Buy');
    assert.equal(await page.locator('.report-rating-title').innerText(), '未识别最终评级');
    assert.doesNotMatch(await page.locator('.report-rating').innerText(), /买入/);
    assert.deepEqual(external, []);
    console.log('Rating UI passed: five official ratings, REVIEW, fallback, conflict, missing and untrusted input.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
