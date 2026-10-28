const test = require('node:test');
const assert = require('node:assert/strict');
const { createBatchRunner } = require('./batch-runner');

test('batch runs sequentially and records failed items without inventing reports', async () => {
  const events = []; const calls = [];
  const batch = createBatchRunner({
    runOne: async ticker => { calls.push(ticker); if (ticker === 'B') throw new Error('sensitive internals'); return { code: 0, reportId: ticker + '/report', stopped: false }; },
    stopActive: () => ({ requested: false }), notify: event => events.push(event),
  });
  const result = await batch.start(['A', 'B', 'C']);
  assert.deepEqual(calls, ['A', 'B', 'C']);
  assert.equal(result.stopped, false);
  assert.equal(result.results[1].reportId, null);
  assert.match(result.results[1].error, /分析未完成/);
  assert.deepEqual(events.map(event => event.status), ['running', 'completed', 'running', 'failed', 'running', 'completed']);
  assert.doesNotMatch(JSON.stringify(result), /sensitive internals/);
});

test('stop during an active item cancels every later item', async () => {
  let resolveRun; let stopCalls = 0; const calls = []; const events = [];
  const batch = createBatchRunner({
    runOne: ticker => { calls.push(ticker); return new Promise(resolve => { resolveRun = resolve; }); },
    stopActive: () => { stopCalls++; return { requested: true }; }, notify: event => events.push(event),
  });
  const pending = batch.start(['A', 'B', 'C']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['A']);
  assert.deepEqual(batch.stop(), { requested: true });
  resolveRun({ code: null, reportId: null, stopped: true });
  const result = await pending;
  assert.equal(result.stopped, true); assert.equal(stopCalls, 1);
  assert.deepEqual(calls, ['A']);
  assert.deepEqual(events.map(event => event.status), ['running', 'stopped', 'cancelled', 'cancelled']);
  assert.ok(result.results.every(entry => entry.reportId === null));
  assert.deepEqual(batch.stop(), { requested: false });
});

test('stop between items preserves completed report and prevents next start', async () => {
  const yields = []; const calls = [];
  const batch = createBatchRunner({
    yieldBetween: () => new Promise(resolve => yields.push(resolve)),
    runOne: async ticker => { calls.push(ticker); return { code: 0, reportId: ticker + '/report' }; },
    stopActive: () => ({ requested: false }),
  });
  const pending = batch.start(['A', 'B']);
  await assert.rejects(batch.start(['C']), /已有批量/);
  yields.shift()();
  while (!yields.length) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(batch.stop(), { requested: true });
  yields.shift()();
  const result = await pending;
  assert.deepEqual(calls, ['A']);
  assert.equal(result.results[0].reportId, 'A/report');
  assert.equal(result.results[1].reportId, null);
  assert.equal(result.stopped, true);
});

test('failed stop signal still prevents the next item and can be retried', async () => {
  let resolveRun; let stops = 0; const calls = [];
  const batch = createBatchRunner({
    runOne: ticker => { calls.push(ticker); return new Promise(resolve => { resolveRun = resolve; }); },
    stopActive: () => { if (++stops === 1) throw new Error('signal failed'); return { requested: true }; },
  });
  const pending = batch.start(['A', 'B']);
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => batch.stop(), /signal failed/);
  assert.deepEqual(batch.stop(), { requested: true });
  resolveRun({ code: null, reportId: null, stopped: true });
  const result = await pending;
  assert.deepEqual(calls, ['A']);
  assert.equal(result.stopped, true);
  assert.equal(result.results[1].reportId, null);
});
