const fs = require('fs');
const actual = require('@actual-app/api');
const { config } = require('./config');

let initPromise = null;

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    fs.mkdirSync(config.ACTUAL_DATA_DIR, { recursive: true });
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

async function getCategoryGroups() {
  await init();
  return await actual.getCategoryGroups();
}

async function getCategories() {
  await init();
  return await actual.getCategories();
}

async function getPayees() {
  await init();
  return await actual.getPayees();
}

async function getTransactions(accountId, startDate, endDate) {
  await init();
  return await actual.getTransactions(accountId, startDate, endDate);
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
  getCategoryGroups,
  getCategories,
  getPayees,
  getTransactions,
  importTransactionsToActual,
  utils: actual.utils,
};
