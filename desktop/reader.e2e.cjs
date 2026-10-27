// Run with Playwright installed and READER_BROWSER_EXECUTABLE set if needed.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER_EXECUTABLE ? { executablePath: process.env.READER_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const externalRequests = [];
    page.on('request', request => { if (/^https?:/i.test(request.url())) externalRequests.push(request.url()); });
    await page.addInitScript(() => {
      window.__reportText = '';
      window.desktop = {
        onLog() {}, onStopError: callback => { window.__stopError = callback; },
        profiles: async () => ({ profiles: [{ id: 'model', name: 'Test', model: 'model' }], selectedId: 'model' }),
        reportsList: async () => [{ id: 'test', title: 'test', ticker: 'TEST', date: '2026-10-27' }],
        readReport: async () => ({ title: 'test', text: window.__reportText }),
        run: () => new Promise(resolve => { window.__finishRun = resolve; }),
        stop: async () => ({ requested: true }),
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.click('[data-page=reader]');
    await page.waitForSelector('.report-item');
    async function render(source) {
      await page.evaluate(text => { window.__reportText = text; }, source);
      await page.click('.report-item');
      await page.waitForFunction(() => !document.querySelector('#reader-document').hidden);
    }

    await render('Price = 10*1.2*1.05 = 12.6\nSpaced = 10 * 1.2 * 1.05\nMixed = 10 *1.2* 1.05\nFormula = A *x* B\nPower = 10**2 + 3**4\n\nAn *important* result and **Rating**.');
    assert.match(await page.locator('#report-content').innerText(), /10\*1\.2\*1\.05/);
    assert.match(await page.locator('#report-content').innerText(), /10 \* 1\.2 \* 1\.05/);
    assert.match(await page.locator('#report-content').innerText(), /10 \*1\.2\* 1\.05/);
    assert.match(await page.locator('#report-content').innerText(), /A \*x\* B/);
    assert.match(await page.locator('#report-content').innerText(), /10\*\*2 \+ 3\*\*4/);
    assert.match(await page.locator('#report-content').innerText(), /\*important\*/);
    assert.equal(await page.locator('#report-content em').count(), 0);
    assert.equal(await page.locator('#report-content strong').innerText(), 'Rating');
    await render('**提示：**本段为示例。');
    assert.equal(await page.locator('#report-content strong').innerText(), '提示：');

    await render('# Trading Analysis Report: TEST\n\n## I. Analyst Team Reports\n\n### Market Analyst\nBuy earlier\n\n## II. Research Team Decision\n\n## III. Trading Team Plan\n\n### Trader\nFINAL TRANSACTION PROPOSAL: BUY\n\n## IV. Risk Management Team Decision\n\n## V. Portfolio Manager Decision\n\n### Portfolio Manager\n**Rating**: Overweight\n\n**Executive Summary**: Wait for confirmation. <script>window.BAD=1</script>');
    assert.equal(await page.locator('.report-decision-label').innerText(), '最终交易建议');
    assert.match(await page.locator('.report-decision-content').innerText(), /Rating: Overweight/);
    assert.match(await page.locator('.report-decision-content').innerText(), /Wait for confirmation/);
    assert.doesNotMatch(await page.locator('.report-decision-content').innerText(), /FINAL TRANSACTION PROPOSAL/);
    assert.equal(await page.locator('.report-decision-content script').count(), 0);
    assert.equal(await page.locator('#report-toc-items button').count(), 5);
    assert.equal(await page.locator('#report-toc-items button').last().innerText(), 'V. Portfolio Manager Decision');
    assert.equal(await page.evaluate(() => document.querySelector('.report-decision').compareDocumentPosition(document.querySelector('#report-toc')) & Node.DOCUMENT_POSITION_FOLLOWING), 4);
    await page.locator('#report-toc-items button').last().click();

    await render('# Trading Analysis Report: TEST\n\n- Rating: Hold\n\n## V. Portfolio Manager Decision\n\n### Portfolio Manager\n**Rating**: Overweight\n\n## 风险与条件\n\nHold until confirmed.\n\n## VI. Appendix\n\nNot part of the final decision.');
    assert.match(await page.locator('.report-decision-content').innerText(), /Rating: Overweight/);
    assert.match(await page.locator('.report-decision-content').innerText(), /风险与条件/);
    assert.doesNotMatch(await page.locator('.report-decision-content').innerText(), /Not part of the final decision/);
    await render('# Trading Analysis Report: TEST\n\n- Rating: REVIEW\n\n## V. Portfolio Manager Decision\n\n### Portfolio Manager\n\n## VI. Appendix\n\n**Rating**: Buy');
    assert.match(await page.locator('.report-decision-empty').innerText(), /最终评级（报告元数据）：REVIEW/);
    assert.doesNotMatch(await page.locator('.report-decision-empty').innerText(), /Buy/);
    assert.equal(await page.locator('.report-decision-content').count(), 0);
    await render('# Trading Analysis Report: TEST\n\n- Analysis date: 2026-10-27\n\n## III. Trading Team Plan\n\n- Rating: Buy');
    assert.match(await page.locator('.report-decision-empty').innerText(), /未找到明确的最终交易建议/);
    assert.doesNotMatch(await page.locator('.report-decision-empty').innerText(), /Buy/);

    await render('# Incomplete\n\n## III. Trading Team Plan\n\n### Trader\nFINAL TRANSACTION PROPOSAL: BUY');
    assert.match(await page.locator('.report-decision-empty').innerText(), /未找到/);
    assert.equal(await page.locator('.report-decision-content').count(), 0);
    await render('## First\n\n### Detail 1\n\n## Second\n\n### Detail 2');
    assert.deepEqual(await page.locator('#report-toc-items button').allTextContents(), ['First', 'Second']);

    await render('## C#\n\n### ABC#\n\n## Closing hashes ###');
    assert.equal(await page.locator('#report-content h2').nth(0).textContent(), 'C#');
    assert.equal(await page.locator('#report-content h3').textContent(), 'ABC#');
    assert.equal(await page.locator('#report-content h2').nth(1).textContent(), 'Closing hashes');

    await render('Price | Level\n--- | ---\nX | value\\|');
    assert.equal(await page.locator('#report-content tbody td').nth(1).textContent(), 'value|');
    await render('Price | Level\n--- | ---\nX | value\\\\|');
    assert.equal(await page.locator('#report-content tbody td').count(), 2);
    assert.equal(await page.locator('#report-content tbody td').nth(1).textContent(), 'value\\\\');

    const nested = '- Positive\n  - Cash surplus\n- Negative\n  - Debt risk';
    await render(nested);
    assert.equal(await page.locator('.report-raw-list').textContent(), nested);

    const wide = Array.from({ length: 70 }, (_, n) => `C${n}`).join(' | ') + '\n' + Array(70).fill('---').join(' | ') + '\n' + Array.from({ length: 70 }, (_, n) => `V${n}`).join(' | ');
    await render(wide);
    assert.equal(await page.locator('.report-raw-table').textContent(), wide);
    assert.equal(await page.locator('#report-content td').count(), 0);

    const tall = 'A | B\n--- | ---\n' + Array.from({ length: 501 }, (_, n) => `${n} | value`).join('\n');
    await render(tall);
    assert.equal(await page.locator('.report-raw-table').textContent(), tall);

    const expansion = Array.from({ length: 50 }, (_, n) => `C${n}`).join(' | ') + '\n' + Array(50).fill('---').join(' | ') + '\n' + Array.from({ length: 201 }, (_, n) => `${n} | value`).join('\n');
    await render(expansion);
    assert.equal(await page.locator('.report-raw-table').textContent(), expansion);
    assert.equal(await page.locator('#report-content td').count(), 0);

    await render('Price | Level\n--- | ---\nClose | 181.2\n\n<script>window.BAD=1</script>\n<img src=x onerror=window.BAD=1>\n![pixel](https://tracker.example/a.png)\n[x](javascript:alert(1))');
    assert.match(await page.locator('#report-content table').innerText(), /181\.2/);
    assert.equal(await page.locator('#report-content script, #report-content img, #report-content iframe, #report-content a').count(), 0);
    assert.match(await page.locator('#report-content').textContent(), /<script>/);
    assert.equal(await page.evaluate(() => window.BAD || 0), 0);
    assert.deepEqual(externalRequests, []);
    await page.click('[data-page=analysis]');
    await page.waitForFunction(() => document.querySelector('#active-profile').value === 'model');
    await page.click('#run'); await page.click('#stop-run');
    await page.waitForFunction(() => document.querySelector('#status').textContent === '正在停止…');
    await page.evaluate(() => window.__stopError('模拟失败'));
    assert.equal(await page.locator('#stop-run').isEnabled(), true);
    assert.equal(await page.locator('#status').textContent(), '停止失败，请重试');
    await page.click('#stop-run');
    assert.equal(await page.locator('#status').textContent(), '正在停止…');
    assert.equal(await page.locator('#home-error').isHidden(), true);
    assert.equal(await page.locator('.status-pill').getAttribute('data-state'), 'busy');
    await page.evaluate(() => window.__finishRun({ code: null, reportId: null, stopped: true }));
    await page.waitForFunction(() => document.querySelector('#status').textContent === '分析已停止');
    console.log('Reader regressions passed: arithmetic, emphasis, nested lists, bounded tables, and untrusted content.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
