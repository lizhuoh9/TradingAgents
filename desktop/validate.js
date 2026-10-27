function validate({ ticker, date }) {
  if (!/^[A-Za-z0-9^][A-Za-z0-9.\-^=]{0,24}$/.test(ticker)) throw new Error('股票代码格式无效');
  if (/^\d{6}$/.test(ticker)) throw new Error('六位数字代码请加市场后缀，例如沪市 600172.SS 或深市 000001.SZ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw new Error('日期格式无效');
}
module.exports = { validate };
