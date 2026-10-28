const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validate } = require('./validate');

const MAX_WATCHLIST = 100;

function normalizeWatchItem(input) {
  if (!input || typeof input !== 'object' || typeof input.ticker !== 'string') throw new Error('股票代码格式无效');
  const ticker = input.ticker.trim().toUpperCase();
  validate({ ticker, date: '2026-01-01' });
  if (input.name != null && typeof input.name !== 'string') throw new Error('股票名称格式无效');
  const name = (input.name || '').trim();
  if (name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('股票名称格式无效');
  return { ticker, name };
}

function createWatchlistStore(file) {
  function list() {
    if (!fs.existsSync(file)) return [];
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('无法读取本地自选列表，原文件未更改'); }
    if (!Array.isArray(data) || data.length > MAX_WATCHLIST) throw new Error('本地自选列表格式无效，原文件未更改');
    const seen = new Set();
    try {
      return data.map(item => {
        const clean = normalizeWatchItem(item);
        if (seen.has(clean.ticker)) throw new Error();
        seen.add(clean.ticker);
        return clean;
      });
    } catch { throw new Error('本地自选列表格式无效，原文件未更改'); }
  }
  function save(items) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(items, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return items;
  }
  return {
    list,
    initialize(getReports) {
      if (fs.existsSync(file)) return list();
      const items = []; const seen = new Set();
      for (const report of getReports()) {
        try {
          const item = normalizeWatchItem({ ticker: report.ticker });
          if (!seen.has(item.ticker)) { seen.add(item.ticker); items.push(item); }
          if (items.length === MAX_WATCHLIST) break;
        } catch { /* Legacy reports may have no valid stock code. */ }
      }
      return items.length ? save(items) : [];
    },
    add(input) {
      const item = normalizeWatchItem(input); const items = list();
      const existing = items.find(entry => entry.ticker === item.ticker);
      if (existing) {
        if (item.name && item.name !== existing.name) { existing.name = item.name; return save(items); }
        return items;
      }
      if (items.length >= MAX_WATCHLIST) throw new Error(`自选最多保存 ${MAX_WATCHLIST} 只股票`);
      items.push(item); return save(items);
    },
    remove(ticker) {
      const item = normalizeWatchItem({ ticker }); const items = list();
      const remaining = items.filter(entry => entry.ticker !== item.ticker);
      return remaining.length === items.length ? items : save(remaining);
    },
  };
}

module.exports = { createWatchlistStore, normalizeWatchItem, MAX_WATCHLIST };
