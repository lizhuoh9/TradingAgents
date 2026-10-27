// Uses local mocked callbacks; no stock data or model requests are made.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER_EXECUTABLE ? { executablePath: process.env.READER_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__runs = [];
      window.desktop = {
        onLog() {}, onStopError() {}, profiles: async () => ({ profiles: [{ id: 'test', name: 'Test', model: 'model' }], selectedId: 'test' }),
        run: async input => { window.__runs.push(input); return { code: 0, reportId: 'test', stopped: false }; },
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.waitForFunction(() => document.querySelector('#active-profile').value === 'test');
    await page.fill('#ticker', '600172');
    await page.click('#run');
    assert.match(await page.locator('#home-error-message').innerText(), /600172\.SS/);
    assert.equal(await page.evaluate(() => window.__runs.length), 0);
    await page.fill('#ticker', '600172.SS');
    await page.click('#run');
    await page.waitForFunction(() => window.__runs.length === 1);
    assert.equal(await page.evaluate(() => window.__runs[0].ticker), '600172.SS');
    console.log('Ticker UI passed: exchange suffix is required for six-digit codes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
