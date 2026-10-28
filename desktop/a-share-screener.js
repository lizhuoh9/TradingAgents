// Public market snapshots only: no user watchlist, model credentials or reports.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const QUOTE_URL = 'https://push2delay.eastmoney.com/api/qt/clist/get';
const FINANCE_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const SOURCE = '东方财富延迟行情与公开财务摘要';
const TENCENT_RANK_URL = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList';
const TENCENT_QUOTES_URL = 'https://qt.gtimg.cn/q=';
const TENCENT_SOURCE = '腾讯公开行情与东方财富公开财务摘要';
const MAX_CANDIDATES = 20;
const MAX_CACHE_AGE = 7 * 24 * 60 * 60 * 1000;

function requestJson(url) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const fail = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      reject(new Error('公开数据接口连接失败或响应无效'));
    };
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://stockapp.finance.qq.com/' } }, res => {
      if (res.statusCode !== 200) { res.destroy(); fail(); return; }
      let size = 0; const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { res.destroy(); fail(); }
        else chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        if (done) return;
        try {
          const bytes = Buffer.concat(chunks);
          const data = new URL(url).hostname === 'qt.gtimg.cn'
            ? new TextDecoder('gb18030', { fatal: true }).decode(bytes)
            : JSON.parse(bytes.toString('utf8'));
          done = true; clearTimeout(timer); resolve(data);
        }
        catch { fail(); }
      });
    });
    req.on('error', fail);
    timer = setTimeout(() => { req.destroy(); fail(); }, 8000);
  });
}

function buildUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

function quoteDate(epoch) {
  if (!Number.isFinite(epoch) || epoch < 946684800 || epoch > 4102444800) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(epoch * 1000));
}

function day(value) {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(String(value || ''));
  if (!match) return '';
  const valueDay = match[0]; const date = new Date(valueDay + 'T00:00:00Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === valueDay ? valueDay : '';
}

function marketAge(marketDate, now) {
  const today = quoteDate(Math.floor(now / 1000));
  if (!today || !day(marketDate)) throw new Error('行情日期无效，请检查数据源或系统时间。');
  const age = (Date.parse(today + 'T00:00:00Z') - Date.parse(marketDate + 'T00:00:00Z')) / 86400000;
  if (age < 0) throw new Error('行情日期晚于当前日期，请检查数据源或系统时间。');
  if (age > 31) throw new Error('行情日期超过 31 天，数据过旧，请稍后重试。');
  return age;
}

function staleWarning(marketDate, age) {
  return age > 7 ? `行情日期为 ${marketDate}，距当前日期 ${age} 天；可能因休市或数据延迟，请核实时效。` : '';
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numericString(value) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function parseTencentRanking(data) {
  const raw = data?.data?.rank_list;
  if (data?.code !== 0 || !Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error('备用行情数据不可用');
  const seen = new Set();
  return raw.flatMap(item => {
    const match = /^(sh6\d{5}|sz[03]\d{5})$/.exec(String(item?.code || ''));
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const price = numericString(item?.zxj), amount = numericString(item?.turnover);
    if (!match || seen.has(match[1]) || !name || name.length > 60 || /[\u0000-\u001f\u007f\ufffd]/.test(name) || /(?:^|\*)ST/i.test(name) || !(price > 0) || !(amount > 0) || !Number.isFinite(amount * 10000)) return [];
    seen.add(match[1]);
    const code = match[1];
    return [{ symbol: code, ticker: `${code.slice(2)}.${code.startsWith('sh') ? 'SS' : 'SZ'}`, name, price,
      changePercent: numericString(item.zdf), turnoverPercent: numericString(item.hsl), turnoverAmount: amount * 10000, volumeRatio: numericString(item.lb) }];
  });
}

function parseTencentQuotes(text, ranking) {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('备用行情日期不可用');
  const quotes = new Map();
  for (const line of text.split(';')) {
    const match = /^\s*v_(sh6\d{5}|sz[03]\d{5})="([^"\r\n]*)"\s*$/.exec(line);
    if (!match || quotes.has(match[1])) continue;
    const fields = match[2].split('~');
    const stamp = fields[30] || '';
    if (fields[2] !== match[1].slice(2) || !/^\d{8}(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(stamp)) continue;
    const date = day(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`);
    const name = (fields[1] || '').trim(), price = numericString(fields[3]), amount = numericString(fields[37]);
    if (!date || !name || name.length > 60 || /[\u0000-\u001f\u007f\ufffd]/.test(name) || /(?:^|\*)ST/i.test(name)
      || !(price > 0) || !(amount > 0) || !Number.isFinite(amount * 10000)) continue;
    quotes.set(match[1], { marketDate: date, name, price, turnoverAmount: amount * 10000,
      changePercent: numericString(fields[32]), turnoverPercent: numericString(fields[38]), volumeRatio: numericString(fields[49]) });
  }
  const dated = ranking.flatMap(({ symbol, ...item }) => quotes.has(symbol) ? [{ ...item, ...quotes.get(symbol) }] : []);
  if (!dated.length) throw new Error('备用行情缺少逐股交易日期');
  const marketDate = dated.reduce((latest, item) => item.marketDate > latest ? item.marketDate : latest, '');
  return { marketDate, items: dated.filter(item => item.marketDate === marketDate).sort((a, b) => b.turnoverAmount - a.turnoverAmount || a.ticker.localeCompare(b.ticker)).slice(0, MAX_CANDIDATES) };
}

function parseQuotes(data) {
  const raw = data?.data?.diff;
  if (!Array.isArray(raw) || !raw.length || raw.length > 1000) throw new Error('行情数据不可用或格式已改变');
  const rows = [];
  for (const item of raw) {
    const code = String(item?.f12 || '');
    const market = item?.f13;
    const suffix = market === 1 && /^6\d{5}$/.test(code) ? 'SS' : market === 0 && /^(?:0|3)\d{5}$/.test(code) ? 'SZ' : '';
    const name = typeof item?.f14 === 'string' ? item.f14.trim() : '';
    const price = numeric(item?.f2), amount = numeric(item?.f6), time = numeric(item?.f124);
    const marketDate = time === null ? '' : quoteDate(time);
    if (!suffix || !name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name) || /(?:^|\*)ST/i.test(name) || !price || price <= 0 || !amount || amount <= 0 || !marketDate) continue;
    rows.push({ ticker: `${code}.${suffix}`, name, price, changePercent: numeric(item.f3), turnoverPercent: numeric(item.f8), turnoverAmount: amount, volumeRatio: numeric(item.f10), marketDate });
  }
  if (!rows.length) throw new Error('行情数据缺少有效标的或时间');
  const marketDate = rows.reduce((latest, item) => item.marketDate > latest ? item.marketDate : latest, '');
  const items = rows.filter(item => item.marketDate === marketDate).sort((a, b) => b.turnoverAmount - a.turnoverAmount || a.ticker.localeCompare(b.ticker)).slice(0, MAX_CANDIDATES);
  return { marketDate, items };
}

function parseFinance(data, code, asOf) {
  if (data?.success !== true || !Array.isArray(data?.result?.data)) throw new Error('财务数据不可用或格式已改变');
  const valid = data.result.data.filter(row => {
    const reportDate = day(row?.REPORTDATE), announcementDate = day(row?.NOTICE_DATE);
    return row?.SECURITY_CODE === code && reportDate && announcementDate && reportDate <= asOf && announcementDate <= asOf;
  }).sort((a, b) => day(b.REPORTDATE).localeCompare(day(a.REPORTDATE)) || day(b.NOTICE_DATE).localeCompare(day(a.NOTICE_DATE)));
  if (!valid.length || numeric(valid[0].PARENT_NETPROFIT) === null) return null;
  const row = valid[0];
  return { netProfit: row.PARENT_NETPROFIT, roe: numeric(row.WEIGHTAVG_ROE), reportDate: day(row.REPORTDATE), announcementDate: day(row.NOTICE_DATE) };
}

async function mapConcurrent(items, limit, fn) {
  const output = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await fn(items[index]); }
  }));
  return output;
}

function readCache(file, now) {
  try {
    if (!file || fs.statSync(file).size > 1024 * 1024) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = now - Date.parse(data.fetchedAt);
    if (![SOURCE, TENCENT_SOURCE].includes(data.source) || !day(data.marketDate) || !Number.isFinite(age) || age < 0 || age > MAX_CACHE_AGE || !Array.isArray(data.candidates) || data.candidates.length > MAX_CANDIDATES) return null;
    if (data.candidates.some(item => !/^\d{6}\.(?:SS|SZ)$/.test(item.ticker) || item.profitStatus !== 'verified_positive' || !(numeric(item.netProfit) > 0)
      || item.marketDate !== data.marketDate || !day(item.reportDate) || !day(item.announcementDate)
      || day(item.reportDate) > data.marketDate || day(item.announcementDate) > data.marketDate)) return null;
    const stale = staleWarning(data.marketDate, marketAge(data.marketDate, now));
    const warnings = (Array.isArray(data.warnings) ? data.warnings : []).filter(value => typeof value === 'string' && !value.startsWith('行情日期为 '));
    return { ...data, cached: true, warnings: [...warnings, ...(stale ? [stale] : []), '公开数据暂时不可用，显示本地缓存；请注意缓存时间。'] };
  } catch { return null; }
}

function writeCache(file, data) {
  if (!file) return;
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function createAShareScreener({ cacheFile, request = requestJson, now = () => Date.now() } = {}) {
  return {
    async screen() {
      try {
        const url = buildUrl(QUOTE_URL, { pn: 1, pz: 60, po: 1, np: 1, fltt: 2, invt: 2, fid: 'f6', fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', fields: 'f2,f3,f6,f8,f9,f10,f12,f13,f14,f124', ut: 'bd1d9ddb04089700cf9c27f6f7426281' });
        let market;
        let source = SOURCE;
        try { market = parseQuotes(await request(url)); }
        catch {
          const rankUrl = buildUrl(TENCENT_RANK_URL, { _appver: '11.17.0', board_code: 'aStock', sort_type: 'turnover', direct: 'down', offset: 0, count: 60 });
          const ranking = parseTencentRanking(await request(rankUrl));
          if (!ranking.length) throw new Error('备用行情无有效标的');
          const quoteUrl = TENCENT_QUOTES_URL + ranking.map(item => item.symbol).join(',');
          market = parseTencentQuotes(await request(quoteUrl), ranking);
          source = TENCENT_SOURCE;
        }
        const { marketDate, items } = market;
        const stale = staleWarning(marketDate, marketAge(marketDate, now()));
        const financial = [];
        const checkFinance = async item => {
          try {
            const code = item.ticker.slice(0, 6);
            const financeUrl = buildUrl(FINANCE_URL, { reportName: 'RPT_LICO_FN_CPD', columns: 'ALL', filter: `(SECURITY_CODE="${code}")`, pageSize: 4, pageNumber: 1, sortColumns: 'REPORTDATE', sortTypes: -1, source: 'WEB', client: 'WEB' });
            return parseFinance(await request(financeUrl), code, marketDate);
          } catch { return null; }
        };
        for (let offset = 0; offset < items.length; offset += 5) {
          financial.push(...await mapConcurrent(items.slice(offset, offset + 5), 5, checkFinance));
          if (financial.filter(row => row?.netProfit > 0).length >= 5) break;
        }
        const verified = financial.filter(Boolean).length;
        if (!verified) throw new Error('无法核实候选股票的历史财务数据，请稍后重试');
        const candidates = items.slice(0, financial.length).flatMap((item, index) => financial[index]?.netProfit > 0 ? [{ ...item, ...financial[index], profitStatus: 'verified_positive' }] : []).slice(0, 5);
        const unknownCount = financial.length - verified;
        const result = { source, fetchedAt: new Date(now()).toISOString(), marketDate, candidates, evaluatedCount: financial.length, unknownCount, cached: false,
          warnings: [`按成交额顺序核查了 ${financial.length} 只沪深 A 股，找到最多 5 只已公告归母净利润为正的候选；过去盈利不代表未来收益。`, ...(source === TENCENT_SOURCE ? ['东方财富行情暂不可用，已使用腾讯备用行情；榜单仅用于选取候选，展示及排序采用逐股行情记录。'] : []), ...(stale ? [stale] : []), ...(unknownCount ? [`${unknownCount} 只股票财务数据未能核实，已排除。`] : [])] };
        try { writeCache(cacheFile, result); } catch { result.warnings.push('无法保存本地缓存，本次结果仍可查看。'); }
        return result;
      } catch (error) {
        const cached = readCache(cacheFile, now());
        if (cached) return cached;
        if (/^行情日期(?:无效|晚于|超过)/.test(error.message)) throw error;
        throw new Error('A 股公开行情或财务数据暂不可用，且没有可用的近期本地缓存；请检查网络后重试。');
      }
    },
  };
}

module.exports = { createAShareScreener, parseQuotes, parseFinance, parseTencentRanking, parseTencentQuotes, requestJson };
