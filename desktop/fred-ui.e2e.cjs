// Run with Playwright installed and READER_BROWSER_EXECUTABLE set if needed.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER_EXECUTABLE ? { executablePath: process.env.READER_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const external = [];
    page.on('request', request => { if (/^https?:/i.test(request.url())) external.push(request.url()); });
    await page.addInitScript(() => {
      let saved = false;
      window.desktop = {
        onLog() {}, onStopError() {}, profiles: async () => ({ profiles: [], selectedId: null }),
        listModels: async () => ({ models: [] }), fredStatus: async () => ({ hasKey: saved }),
        saveFredKey: async key => { if (key) saved = true; return { hasKey: saved }; },
        deleteFredKey: async () => { saved = false; return { hasKey: false }; },
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.click('[data-page=settings]');
    await page.fill('#fred-key', 'fictionalFredKey012345');
    await page.click('#fred-save');
    await page.waitForFunction(() => document.querySelector('#fred-status').textContent.includes('已保存'));
    assert.equal(await page.inputValue('#fred-key'), '');
    assert.match(await page.textContent('#fred-hint'), /留空将保留/);
    assert.doesNotMatch(await page.locator('body').innerText(), /fictionalFredKey012345/);
    await page.click('#fred-save');
    assert.match(await page.textContent('#fred-hint'), /留空将保留/);
    page.once('dialog', dialog => dialog.accept());
    await page.click('#fred-delete');
    await page.waitForFunction(() => document.querySelector('#fred-status').textContent.includes('已删除'));
    assert.equal(await page.locator('#fred-delete').isHidden(), true);
    const recovery = await browser.newPage();
    await recovery.addInitScript(() => {
      let readable = false;
      window.desktop = {
        onLog() {}, onStopError() {}, profiles: async () => ({ profiles: [], selectedId: null }),
        listModels: async () => ({ models: [] }),
        fredStatus: async () => { if (!readable) throw Error('无法解密已保存的数据服务密钥'); return { hasKey: false }; },
        backupUnreadableFredKey: async () => { readable = true; return 'local-backup'; },
      };
    });
    await recovery.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await recovery.click('[data-page=settings]');
    await recovery.waitForSelector('#fred-recover:not([hidden])');
    await recovery.fill('#fred-key', '0123456789abcdef0123456789abcdef');
    recovery.once('dialog', dialog => dialog.accept());
    await recovery.click('#fred-recover');
    await recovery.waitForFunction(() => document.querySelector('#fred-status').textContent.includes('local-backup'));
    assert.equal(await recovery.inputValue('#fred-key'), '0123456789abcdef0123456789abcdef');
    assert.equal(await recovery.locator('#fred-recover').isHidden(), true);
    assert.match(await recovery.textContent('#fred-status'), /暂不配置继续分析/);
    await recovery.close();
    assert.deepEqual(external, []);
    console.log('FRED settings passed: save, retain, delete, secret isolation and no network.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
