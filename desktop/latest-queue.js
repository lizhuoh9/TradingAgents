function createLatestQueue(worker) {
  let active = false;
  let pending = null;
  async function start(entry) {
    active = true;
    try { entry.resolve(await worker(entry.value)); }
    catch (error) { entry.reject(error); }
    finally {
      active = false;
      if (pending) { const next = pending; pending = null; start(next); }
    }
  }
  return {
    submit(value) {
      return new Promise((resolve, reject) => {
        const entry = { value, resolve, reject };
        if (!active) start(entry);
        else { if (pending) pending.resolve({ superseded: true }); pending = entry; }
      });
    },
    isBusy: () => active || Boolean(pending),
  };
}
module.exports = { createLatestQueue };
