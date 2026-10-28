const { createWatchlistStore } = require('./watchlist-store');

function createHoldingsStore(file) {
  const store = createWatchlistStore(file);
  const call = (method, ...args) => {
    try { return store[method](...args); }
    catch (error) { throw new Error(error.message.replaceAll('自选', '持仓')); }
  };
  return {
    list: () => call('list'),
    add: input => call('add', input),
    remove: ticker => call('remove', ticker),
  };
}

module.exports = { createHoldingsStore };
