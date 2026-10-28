// Serial batch execution keeps the upstream shared cache and memory transactional.
function createBatchRunner({ runOne, stopActive, notify = () => {}, yieldBetween = () => new Promise(resolve => setImmediate(resolve)) }) {
  let active = null;
  const emit = event => { try { notify(event); } catch { /* A closed UI must not stop cleanup. */ } };
  return {
    async start(tickers) {
      if (active) throw new Error('已有批量分析正在运行');
      const batch = { cancelled: false }; active = batch;
      const results = [];
      try {
        for (const ticker of tickers) {
          // Give stop requests a chance to run before starting another child.
          await yieldBetween();
          if (batch.cancelled) {
            const result = { ticker, code: null, reportId: null, stopped: true };
            results.push(result); emit({ ...result, status: 'cancelled' }); continue;
          }
          emit({ ticker, status: 'running' });
          let result;
          try {
            const value = await runOne(ticker);
            result = { ticker, code: value.code ?? null, reportId: value.reportId || null, stopped: Boolean(value.stopped) };
            if (!result.stopped && (result.code !== 0 || !result.reportId)) result.error = '分析未完成，请查看运行日志';
          } catch {
            result = { ticker, code: null, reportId: null, stopped: false, error: '分析未完成，请查看运行日志' };
          }
          results.push(result);
          emit({ ...result, status: result.stopped ? 'stopped' : result.error ? 'failed' : 'completed' });
        }
        return { results, stopped: batch.cancelled };
      } finally { if (active === batch) active = null; }
    },
    stop() {
      if (!active) return { requested: false };
      active.cancelled = true;
      stopActive();
      return { requested: true };
    },
    isActive: () => Boolean(active),
  };
}

module.exports = { createBatchRunner };
