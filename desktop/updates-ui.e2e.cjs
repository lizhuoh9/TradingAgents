// Mocked update sources: this test never downloads or installs application files.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER_EXECUTABLE ? { executablePath: process.env.READER_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    await page.addInitScript(() => {
      const state = {
        checkedAt: '2026-10-28T10:00:00Z',
        kernel: { current: 'v0.7.0 · abcdef0', latest: 'v0.7.1 · 1234567', available: true, status: 'available' },
        ui: { current: '0.2.0', latest: '0.3.0', available: true, status: 'available' },
      };
      window.__updates = { state, installs: [], checks: [], reloads: 0, failCheck: false };
      window.desktop = {
        onLog() {}, onStopError() {},
        profiles: async () => ({ profiles: [{ id: 'test', name: '演示连接', model: 'mock' }], selectedId: 'test' }),
        watchlist: async () => [], reportsList: async () => [],
        checkUpdates: async force => {
          window.__updates.checks.push(force);
          if (window.__updates.failCheck) throw new Error('版本服务器暂不可用');
          if (window.__updates.holdNextCheck) {
            window.__updates.holdNextCheck = false;
            const beforeInstall = structuredClone(state);
            return new Promise(resolve => { window.__updates.releaseCheck = () => resolve(beforeInstall); });
          }
          return structuredClone(state);
        },
        onUpdatesChanged: callback => { window.__updates.emit = callback; },
        update: target => {
          window.__updates.installs.push(target);
          return new Promise((resolve, reject) => {
            window.__updates.finishInstall = () => {
              state[target] = { ...state[target], current: state[target].latest, available: false, status: 'current' };
              resolve('更新完成');
            };
            window.__updates.failInstall = () => reject(new Error('本地文件有修改，未覆盖'));
          });
        },
        reloadUi: async () => { window.__updates.reloads++; },
        run: () => new Promise(resolve => { window.__updates.finishRun = () => resolve({ code: 1, reportId: null }); }),
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.waitForSelector('#update-dot:not([hidden])');
    assert.equal(await page.locator('#update').getAttribute('aria-label'), '更新（有新版本）');
    await page.click('#update');
    await page.waitForSelector('#updates-dialog[open]');
    assert.equal(await page.locator('#kernel-update-current').innerText(), 'v0.7.0 · abcdef0');
    assert.equal(await page.locator('#ui-update-latest').innerText(), '0.3.0');
    assert.equal(await page.locator('#update-dot').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.__updates.installs), []);
    if (process.env.UPDATE_PREVIEW_PATH) await page.screenshot({ path: process.env.UPDATE_PREVIEW_PATH });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#updates-dialog').getAttribute('open'), null);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'update');

    await page.click('#run');
    await page.waitForFunction(() => typeof window.__updates.finishRun === 'function');
    assert.equal(await page.locator('#update').isEnabled(), true);
    await page.click('#update');
    assert.equal(await page.locator('#update-kernel').isDisabled(), true);
    assert.equal(await page.locator('#update-ui').isDisabled(), true);
    assert.match(await page.locator('#updates-busy').innerText(), /任务运行中/);
    await page.evaluate(() => window.__updates.finishRun());
    await page.waitForFunction(() => !document.querySelector('#update-kernel').disabled);

    await page.click('#update-kernel');
    await page.waitForFunction(() => window.__updates.installs.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__updates.installs), ['kernel']);
    assert.equal(await page.locator('#update-ui').isDisabled(), true);
    await page.evaluate(() => window.__updates.failInstall());
    await page.waitForFunction(() => /本地文件有修改/.test(document.querySelector('#updates-message').textContent));
    assert.equal(await page.locator('#update-dot').isVisible(), true);
    assert.equal(await page.locator('#ui-reload-notice').isVisible(), false);

    await page.click('#update-kernel');
    await page.waitForFunction(() => window.__updates.installs.length === 2);
    await page.evaluate(() => window.__updates.finishInstall());
    await page.waitForFunction(() => document.querySelector('#kernel-update-status').textContent === '已是最新');
    assert.equal(await page.locator('#update-dot').isVisible(), true);

    await page.evaluate(() => { window.__updates.failCheck = true; });
    await page.click('#check-updates');
    await page.waitForFunction(() => document.querySelector('#ui-update-status').textContent === '检查失败');
    assert.match(await page.locator('#ui-update-error').innerText(), /版本服务器暂不可用/);
    assert.equal(await page.locator('#update-dot').isVisible(), true);
    assert.equal(await page.evaluate(() => window.__updates.checks.at(-1)), true);
    await page.evaluate(() => { window.__updates.failCheck = false; });
    await page.click('#check-updates');
    await page.waitForFunction(() => document.querySelector('#ui-update-status').textContent === '有新版本');

    await page.evaluate(() => { window.__updates.holdNextCheck = true; });
    await page.click('#check-updates');
    await page.waitForFunction(() => typeof window.__updates.releaseCheck === 'function');
    const checkCount = await page.evaluate(() => window.__updates.checks.length);
    await page.click('#update-ui');
    await page.waitForFunction(() => window.__updates.installs.length === 3);
    assert.deepEqual(await page.evaluate(() => window.__updates.installs), ['kernel', 'kernel', 'ui']);
    await page.evaluate(() => window.__updates.finishInstall());
    await page.waitForFunction(() => /界面更新已安装/.test(document.querySelector('#updates-message').textContent));
    await page.evaluate(() => window.__updates.releaseCheck());
    await page.waitForSelector('#ui-reload-notice:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#update-dot').hidden);
    assert.equal(await page.evaluate(() => window.__updates.checks.length), checkCount + 1);
    assert.match(await page.locator('#ui-reload-notice').innerText(), /未保存的表单内容会清空/);
    assert.equal(await page.evaluate(() => window.__updates.reloads), 0);
    await page.click('#reload-ui');
    assert.equal(await page.evaluate(() => window.__updates.reloads), 1);
    await page.evaluate(() => window.__updates.emit({ ...window.__updates.state, ui: { current: '0.3.0', latest: '0.4.0', available: true, status: 'blocked', error: '请先升级完整桌面程序' } }));
    assert.equal(await page.locator('#update-ui').isDisabled(), true);
    assert.equal(await page.locator('#update-dot').isVisible(), true);
    assert.match(await page.locator('#ui-update-error').innerText(), /完整桌面程序/);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    console.log('Update UI passed: independent choices, notification dot, busy guards, failed checks/install, compatibility warning and explicit reload.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
