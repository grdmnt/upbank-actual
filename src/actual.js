const actual = require('@actual-app/api');
const { config } = require('./config');

let initPromise = null;

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await actual.init({
      dataDir: config.ACTUAL_DATA_DIR,
      serverURL: config.ACTUAL_SERVER_URL,
      password: config.ACTUAL_PASSWORD,
    });

    if (config.ACTUAL_BUDGET_ENCRYPTION_PASSWORD) {
      await actual.downloadBudget(config.ACTUAL_BUDGET_ID, {
        password: config.ACTUAL_BUDGET_ENCRYPTION_PASSWORD,
      });
    } else {
      await actual.downloadBudget(config.ACTUAL_BUDGET_ID);
    }
  })();
  return initPromise;
}

async function shutdown() {
  try {
    await actual.shutdown();
  } catch (_) {
    // ignore
  }
}

async function listAccounts() {
  await init();
  return await actual.getAccounts();
}

async function importTransactionsToActual(accountId, transactions) {
  await init();
  console.log(`[Actual] importing ${transactions.length} transactions to account ${accountId}`);
  return await actual.importTransactions(accountId, transactions);
}

module.exports = {
  init,
  shutdown,
  listAccounts,
  importTransactionsToActual,
  utils: actual.utils,
};
