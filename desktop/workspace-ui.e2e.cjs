// Mock-only desktop layout and interaction checks. No user files or APIs are used.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const screenshots = process.env.UI_SCREENSHOT_DIR || path.join(__dirname, 'local-data', 'ui-review');
  fs.mkdirSync(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER_EXECUTABLE ? { executablePath: process.env.READER_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const externalRequests = [];
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/i.test(request.url())) externalRequests.push(request.url()); });
    await page.route(/^https?:/, route => route.abort());
    await page.addInitScript(() => {
      const profiles = [
        { id: 'research', name: '研究模型（演示）', model: 'research-model', provider: 'openai_compatible', baseUrl: 'https://example.invalid/v1', hasKey: true },
        { id: 'local', name: '本机模型（演示）', model: 'local-reasoning', provider: 'openai_compatible', baseUrl: 'http://localhost:11434/v1', hasKey: false },
      ];
      let watchlist = [{ ticker: 'AAPL', name: '苹果 · 演示数据' }, { ticker: 'MSFT', name: '微软 · 演示数据' }, { ticker: '600519.SS', name: '贵州茅台 · 演示数据' }];
      const reports = [
        { id: 'aapl', ticker: 'AAPL', date: '2026-10-28', title: 'AAPL_20261028_103000_演示报告' },
        { id: 'msft', ticker: 'MSFT', date: '2026-10-28', title: 'MSFT_20261028_110000_演示报告' },
        { id: 'maotai', ticker: '600519.SS', date: '2026-10-27', title: '600519.SS_20261027_110000_演示报告' },
      ];
      const reportText = (ticker, rating) => `# Trading Analysis Report: ${ticker}\n\n- Analysis date: 2026-10-28\n- Rating: ${rating}\n\n> 界面演示数据，不是真实分析或投资建议。\n\n## I. Analyst Team Reports\n\n### 市场观察\n\n本段只用于检查报告的阅读层级、间距与长文排版。成交量与价格的变化需要结合风险条件理解。\n\n| 观察项目 | 当前判断 | 需要关注 |\n| --- | --- | --- |\n| 趋势结构 | 等待确认 | 价格与成交量 |\n| 估值水平 | 保持审慎 | 财报与指引 |\n\n## II. Research Team Decision\n\n研究团队对基本面保持关注，短期执行仍需要确认条件。\n\n## III. Trading Team Plan\n\n保持耐心，不根据单次价格波动做出决策。\n\n## IV. Risk Management Team Decision\n\n- 控制仓位与单一标的风险\n- 在关键数据发布后重新核查\n\n## V. Portfolio Manager Decision\n\n### Portfolio Manager\n\n**Rating**: ${rating}\n\n**Executive Summary**: 这是界面测试用的示例结论。先观察趋势确认，分步评估执行条件，并保留风险预算。\n\n**Investment Thesis**: 基本面与市场情绪需要交叉验证。任何结论都依赖数据时效及后续变化。\n\n**Time Horizon**: 3–6 months`;
      window.__ui = { screenCalls: 0, finish: null, log: null, progress: null, profiles, reports, longReport: false };
      window.desktop = {
        onLog: callback => { window.__ui.log = callback; },
        onStopError() {},
        onBatchProgress: callback => { window.__ui.progress = callback; },
        profiles: async () => ({ profiles, selectedId: 'research' }),
        selectProfile: async id => ({ profiles, selectedId: id }),
        listModels: async () => ({ models: [{ id: 'research-model', name: 'Research model' }, { id: 'local-reasoning', name: 'Local reasoning' }] }),
        fredStatus: async () => ({ hasKey: false }),
        watchlist: async () => watchlist,
        watchlistAdd: async item => { if (!watchlist.some(row => row.ticker === item.ticker)) watchlist.push(item); return watchlist; },
        watchlistRemove: async ticker => { watchlist = watchlist.filter(item => item.ticker !== ticker); return watchlist; },
        reportsList: async () => reports,
        readReport: async id => {
          const entry = reports.find(item => item.id === id);
          const text = reportText(entry.ticker, id === 'aapl' ? 'Overweight' : id === 'msft' ? 'Hold' : 'Underweight');
          return { title: entry.title, text: text + (window.__ui.longReport ? '\n\n## VI. 阅读滚动检查\n\n' + Array.from({ length: 80 }, (_, index) => `演示段落 ${index + 1}：用于核查切换报告后是否仍能先看到最终建议。`).join('\n\n') : '') };
        },
        run: () => new Promise(resolve => { window.__ui.finish = resolve; }),
        stop: async () => ({ requested: true }),
        screenAShares: async () => {
          window.__ui.screenCalls++;
          return {
            source: '本地界面演示数据', marketDate: '2026-10-28', fetchedAt: '2026-10-28 10:30', warnings: ['仅用于布局检查，不是真实行情'],
            candidates: [
              { ticker: '600519.SS', name: '贵州茅台（演示）', profitStatus: 'verified_positive', netProfit: 300000000, price: 100, changePercent: 1.25, turnoverPercent: 2.3, turnoverAmount: 900000000, reportDate: '2026-06-30', announcementDate: '2026-08-20' },
              { ticker: '300750.SZ', name: '宁德时代（演示）', profitStatus: 'verified_positive', netProfit: 200000000, price: 80, changePercent: -0.5, turnoverPercent: 1.2, turnoverAmount: 500000000, reportDate: '2026-06-30', announcementDate: '2026-08-25' },
            ],
          };
        },
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.waitForFunction(() => document.querySelector('#active-profile').value === 'research');
    const capture = async name => {
      await page.mouse.move(Math.min(700, page.viewportSize().width - 1), 1);
      await page.waitForTimeout(180); // Allow the existing hover transition to settle.
      await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
    };
    const navigate = async name => {
      await page.locator(`.navigation [data-page="${name}"]`).click();
      await page.locator(`[data-view="${name}"]`).waitFor({ state: 'visible' });
    };
    const assertNoOverflow = async context => {
      const result = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(result.scroll <= result.width + 1, `${context}: page width ${result.scroll} exceeds viewport ${result.width}`);
    };
    await capture('analysis-empty');
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'true');
    await page.click('#sidebar-toggle');
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.app-shell.sidebar-collapsed').count(), 1);
    await navigate('watchlist');
    await page.waitForFunction(() => document.querySelectorAll('.watch-item').length === 3);
    assert.equal(await page.locator('.navigation [data-page="watchlist"]').getAttribute('aria-current'), 'page');
    await page.click('#sidebar-toggle');
    await navigate('analysis');
    await page.fill('#ticker', 'AAPL');
    await page.click('#run');
    await page.waitForFunction(() => typeof window.__ui.finish === 'function');
    await page.evaluate(() => window.__ui.log('[10:30:00] 开始分析 AAPL · 以下均为本地界面演示日志\n[10:30:01] 正在整理行情与新闻\n[10:30:02] 市场分析师正在核查趋势结构\n[10:30:03] 基本面分析师正在检查财务资料\n[10:30:04] 研究团队正在汇总观点\n'));
    await capture('analysis-running');
    assert.equal(await page.locator('#log-wrap').getAttribute('aria-pressed'), 'true');
    await page.click('#log-wrap');
    assert.equal(await page.locator('#log-wrap').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#log.log-nowrap').count(), 1);
    await page.evaluate(() => window.__ui.log('LONG_LOG_' + 'value '.repeat(100) + '\n' + Array.from({ length: 150 }, (_, index) => `Log line ${index}: local synthetic progress`).join('\n') + '\n'));
    await page.waitForFunction(() => { const log = document.querySelector('#log'); return log.scrollHeight - log.scrollTop - log.clientHeight < 48; });
    await assertNoOverflow('wide log is contained');
    await page.click('#log-follow');
    assert.equal(await page.locator('#log-follow').getAttribute('aria-pressed'), 'false');
    await page.locator('#log').evaluate(log => { log.scrollTop = 0; });
    await page.evaluate(() => window.__ui.log('A new log must not interrupt reading older lines.\n'));
    assert.equal(await page.locator('#log').evaluate(log => log.scrollTop), 0);
    await page.click('#log-follow');
    assert.equal(await page.locator('#log-follow').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => { const log = document.querySelector('#log'); return log.scrollHeight - log.scrollTop - log.clientHeight < 48; });
    await navigate('watchlist');
    await page.evaluate(() => window.__ui.log(Array.from({ length: 100 }, (_, index) => `Hidden analysis progress ${index}`).join('\n') + '\n'));
    await navigate('analysis');
    await page.waitForFunction(() => { const log = document.querySelector('#log'); return log.scrollHeight - log.scrollTop - log.clientHeight < 48; });
    assert.equal(await page.locator('#log-follow').getAttribute('aria-pressed'), 'true');
    await page.locator('#log').evaluate(log => { log.scrollTop = 100; });
    await page.waitForFunction(() => document.querySelector('#log-follow').getAttribute('aria-pressed') === 'false');
    await navigate('watchlist');
    await page.evaluate(() => window.__ui.log('New output while the user is reading earlier log lines.\n'));
    await navigate('analysis');
    assert.equal(await page.locator('#log-follow').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#log').evaluate(log => log.scrollTop), 100);
    await page.click('#log-follow');
    await page.click('#log-wrap');
    await page.evaluate(() => window.__ui.finish({ code: 0, stopped: false, reportId: 'aapl' }));
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('报告已保存'));
    await navigate('watchlist');
    await page.waitForFunction(() => document.querySelector('#watch-list').textContent.includes('偏买'));
    await capture('watchlist');
    assert.equal(await page.locator('.watch-item').count(), 3);
    assert.ok((await page.locator('.watch-item').evaluateAll(rows => rows.map(row => row.dataset.state))).every(state => /^[a-z-]+$/.test(state)));
    await navigate('reader');
    await page.locator('.report-item').first().click();
    await page.locator('#reader-document').waitFor({ state: 'visible' });
    assert.match(await page.locator('.report-rating-title').innerText(), /偏买/);
    assert.ok(await page.locator('.report-decision').evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('#report-toc')) & Node.DOCUMENT_POSITION_FOLLOWING)));
    await capture('reader');
    await navigate('markets');
    assert.equal(await page.evaluate(() => window.__ui.screenCalls), 0);
    await page.click('#screen-ashares');
    await page.waitForSelector('.screen-item');
    assert.equal(await page.evaluate(() => window.__ui.screenCalls), 1);
    await capture('markets');
    await navigate('settings');
    await page.locator('.profile-item').first().click();
    await page.waitForFunction(() => !document.querySelector('#profile-model-choice').disabled);
    await capture('settings');

    await page.evaluate(() => { window.__ui.longReport = true; });
    await navigate('reader');
    await page.locator('.report-item').first().click();
    await page.locator('#reader-document').waitFor({ state: 'visible' });
    await page.locator('.reader-paper').evaluate(paper => paper.scrollTo({ top: paper.scrollHeight, behavior: 'instant' }));
    assert.ok(await page.locator('.reader-paper').evaluate(paper => paper.scrollTop > 0), 'Long report must exercise its independent scroll container');
    await page.locator('.report-item').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#document-title').textContent.includes('MSFT') && !document.querySelector('#reader-document').hidden);
    assert.equal(await page.locator('.reader-paper').evaluate(paper => paper.scrollTop), 0, 'Opening a different report must show its header and final decision');
    await page.evaluate(() => { window.__ui.longReport = false; });

    for (const [width, height] of [[1024, 800], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const name of ['analysis', 'watchlist', 'reader', 'settings']) {
        await navigate(name);
        if (name === 'reader') {
          await page.locator('.report-item').first().click();
          await page.locator('#reader-document').waitFor({ state: 'visible' });
        }
        await capture(`${name}-${width}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await navigate('settings');

    // Long provider IDs and report names must not determine the width of a pane.
    await page.evaluate(() => {
      window.__ui.profiles[0].model = 'model-' + 'long-provider-qualified-name-'.repeat(8);
      window.__ui.reports[0].title = 'AAPL_' + '20261028_run-abcdef0123456789_'.repeat(12);
    });
    await page.locator('.profile-item').first().click();
    for (const [width, height] of [[1440, 960], [1024, 800], [780, 800], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const name of ['analysis', 'watchlist', 'reader', 'markets', 'settings']) {
        await navigate(name);
        if (name === 'reader') {
          await page.locator('.report-item').first().click();
          await page.locator('#reader-document').waitFor({ state: 'visible' });
          const bounds = await page.locator('.report-item').first().evaluate(item => {
            const card = item.getBoundingClientRect(); const list = document.querySelector('.reader-list').getBoundingClientRect();
            return { cardRight: card.right, listRight: list.right };
          });
          assert.ok(bounds.cardRight <= bounds.listRight + 1, `${width}: long report escapes library`);
        }
        await assertNoOverflow(`${name} at ${width}×${height}`);
      }
    }
    assert.deepEqual(externalRequests, [], 'Interface rendering must not access the network');
    assert.deepEqual(pageErrors, [], 'All pages and controls must run without renderer exceptions');
    console.log(`Workspace UI passed: all 5 pages at 4 widths, sidebar, log wrapping/follow across navigation, report scroll reset/boundaries and zero external requests. Screenshots: ${screenshots}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
