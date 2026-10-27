// Run with Playwright installed; set MODEL_UI_BROWSER_EXECUTABLE if needed.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.MODEL_UI_BROWSER_EXECUTABLE ? { executablePath: process.env.MODEL_UI_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const external = [];
    page.on('request', request => { if (/^https?:/i.test(request.url())) external.push(request.url()); });
    await page.addInitScript(() => {
      let state = { profiles: [{ id: 'saved', name: 'Example', provider: 'openai_compatible', baseUrl: 'https://example.test/v1', model: 'old-model', hasKey: true }], selectedId: 'saved' };
      window.__catalogCalls = []; window.__activeCatalog = 0; window.__maxCatalog = 0; window.__savedProfile = null; window.__saveCount = 0; window.__fetchCalls = []; window.__fetchMode = 'ok';
      window.desktop = {
        onLog() {}, onStopError() {}, profiles: async () => state,
        listModels: async input => {
          window.__catalogCalls.push(input); window.__activeCatalog++;
          window.__maxCatalog = Math.max(window.__maxCatalog, window.__activeCatalog);
          await new Promise(resolve => setTimeout(resolve, input.baseUrl.includes('slow') ? 1400 : 10));
          window.__activeCatalog--;
          return input.baseUrl.includes('fast')
            ? { models: [{ id: 'fast-model', label: 'Fast model' }] }
            : { detectedProvider: 'sample', models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }] };
        },
        fetchModels: async input => {
          window.__fetchCalls.push(input);
          if (window.__fetchMode === 'slow') await new Promise(resolve => setTimeout(resolve, 1400));
          if (window.__fetchMode === 'fail') throw new Error('密钥无效或无访问权限: fictional-secret');
          return { models: [{ id: 'live-model', label: 'Live model' }, { id: '<img src=x>', label: '<img src=x>' }] };
        },
        saveProfile: async input => {
          window.__saveCount++;
          window.__savedProfile = input;
          state = { profiles: [{ ...input, id: 'saved', hasKey: true, key: undefined }], selectedId: 'saved' };
          return state;
        },
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.click('.navigation [data-page=settings]');
    await page.waitForSelector('.profile-item');
    await page.click('.profile-item');
    await page.waitForFunction(() => !document.querySelector('#profile-model-choice').disabled && document.querySelector('#model-catalog-status').textContent.includes('官方适配方式') && Array.from(document.querySelector('#profile-model-choice').options).some(option => option.value === 'model-a'));
    assert.equal(await page.inputValue('#profile-model'), 'old-model');
    assert.equal(await page.inputValue('#profile-key'), '');
    assert.match(await page.textContent('#profile-key-hint'), /保留原密钥/);
    assert.match(await page.textContent('#model-catalog-status'), /官方适配方式/);
    assert.equal(await page.evaluate(() => window.__fetchCalls.length), 0);
    await page.click('#model-fetch');
    await page.waitForFunction(() => document.querySelector('#model-fetch-status').textContent.includes('连接成功'));
    const savedFetch = await page.evaluate(() => window.__fetchCalls.at(-1));
    assert.equal(savedFetch.profileId, 'saved'); assert.equal(savedFetch.key, '');
    assert.equal(await page.inputValue('#profile-model'), 'old-model');
    assert.equal(await page.locator('#profile-model-choice img').count(), 0);
    await page.click('#model-refresh');
    await page.waitForFunction(() => Array.from(document.querySelector('#profile-model-choice').options).some(option => option.value === 'model-a'));
    await page.evaluate(() => { window.__fetchMode = 'fail'; });
    await page.click('#model-fetch');
    await page.waitForFunction(() => document.querySelector('#model-fetch-status').textContent.includes('连接失败'));
    assert.match(await page.textContent('#model-fetch-status'), /密钥无效或无访问权限/);
    assert.doesNotMatch(await page.textContent('#model-fetch-status'), /fictional-secret/);
    assert.equal(await page.locator('#profile-model-choice option[value="model-a"]').count(), 1);
    await page.evaluate(() => { window.__fetchMode = 'slow'; });
    await page.click('#model-fetch');
    await page.click('#new-profile');
    await page.waitForTimeout(1600);
    assert.equal(await page.locator('#profile-model-choice option[value="live-model"]').count(), 0);
    await page.fill('#profile-url', 'https://new.example/v1');
    await page.fill('#profile-key', 'fictional-new-key');
    await page.evaluate(() => { window.__fetchMode = 'ok'; });
    await page.click('#model-fetch');
    await page.waitForFunction(() => document.querySelector('#model-fetch-status').textContent.includes('连接成功'));
    const newFetch = await page.evaluate(() => window.__fetchCalls.at(-1));
    assert.equal(newFetch.profileId, undefined); assert.equal(newFetch.key, 'fictional-new-key');
    assert.equal(await page.evaluate(() => window.__saveCount), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /fictional-new-key/);
    await page.click('.profile-item');
    await page.waitForFunction(() => !document.querySelector('#profile-model-choice').disabled && Array.from(document.querySelector('#profile-model-choice').options).some(option => option.value === 'model-b'));
    await page.selectOption('#profile-model-choice', 'model-b');
    assert.equal(await page.inputValue('#profile-model'), 'model-b');
    await page.click('#save-profile');
    await page.waitForFunction(() => document.querySelector('#settings-message').textContent.includes('已保存'));
    const saved = await page.evaluate(() => window.__savedProfile);
    assert.equal(saved.id, 'saved'); assert.equal(saved.model, 'model-b'); assert.equal(saved.key, '');
    await page.fill('#profile-model', 'custom-model');
    assert.equal(await page.inputValue('#profile-model-choice'), '');
    await page.fill('#profile-url', 'https://slow.example/v1');
    await page.waitForTimeout(350);
    for (let i = 0; i < 3; i++) { await page.fill('#profile-url', `https://fast${i}.example/v1`); await page.waitForTimeout(350); }
    await page.waitForFunction(() => Array.from(document.querySelector('#profile-model-choice').options).some(option => option.value === 'fast-model'), null, { timeout: 8000 });
    assert.equal(await page.inputValue('#profile-model'), 'custom-model');
    assert.equal(await page.locator('#profile-model-choice option[value="model-a"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__maxCatalog), 1);
    const calls = await page.evaluate(() => window.__catalogCalls);
    assert.equal(calls.at(-1).baseUrl, 'https://fast2.example/v1');
    assert.deepEqual(Object.keys(calls.at(-1)).sort(), ['baseUrl', 'provider']);
    assert.equal(external.length, 0);
    const recovery = await browser.newPage();
    await recovery.addInitScript(() => {
      let available = false;
      window.desktop = {
        onLog() {}, onStopError() {},
        profiles: async () => { if (!available) throw new Error('无法解密已保存的连接'); return { profiles: [], selectedId: null }; },
        backupUnreadableProfiles: async () => { available = true; return 'local-backup'; },
        listModels: async () => ({ models: [] }),
        saveProfile: async input => { if (!available) throw new Error('无法解密已保存的连接'); window.__recoveredInput = input; return { profiles: [{ ...input, id: 'new', key: undefined, hasKey: true }], selectedId: 'new' }; },
      };
    });
    await recovery.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await recovery.waitForFunction(() => document.querySelector('#active-profile').textContent.includes('无法读取'));
    await recovery.click('.navigation [data-page=settings]');
    assert.equal(await recovery.locator('#recover-profiles').isVisible(), true);
    await recovery.click('#new-profile');
    assert.match(await recovery.textContent('#profiles-status'), /读取连接失败/);
    await recovery.fill('#profile-name', 'My connection');
    await recovery.fill('#profile-url', 'https://example.test/v1');
    await recovery.fill('#profile-model', 'model-a');
    await recovery.fill('#profile-key', 'fictional-key');
    await recovery.click('#save-profile');
    await recovery.waitForFunction(() => document.querySelector('#settings-message').textContent.includes('暂时不能保存'));
    assert.equal(await recovery.inputValue('#profile-key'), 'fictional-key');
    assert.equal(await recovery.locator('#recover-profiles-inline').isVisible(), true);
    recovery.once('dialog', dialog => dialog.accept());
    await recovery.click('#recover-profiles-inline');
    await recovery.waitForFunction(() => document.querySelector('#settings-message').textContent.includes('local-backup'));
    assert.equal(await recovery.locator('#recover-profiles').isHidden(), true);
    assert.equal(await recovery.inputValue('#profile-key'), 'fictional-key');
    assert.equal(await recovery.inputValue('#profile-model'), 'model-a');
    await recovery.click('#save-profile');
    await recovery.waitForFunction(() => document.querySelector('#settings-message').textContent.includes('连接已保存'));
    assert.equal(await recovery.evaluate(() => window.__recoveredInput.key), 'fictional-key');
    assert.equal(await recovery.inputValue('#profile-key'), '');
    await recovery.close();
    console.log('Model UI passed: saved model/key handling, selection, custom IDs, request isolation and no network.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
