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

/**
 * Find a transaction by Up id across EVERY account.
 *
 * Actual's own dedupe is per-account, so once a purchase is absorbed onto a saver
 * the settled webhook would re-import it into Up Bank as a fresh row. Looking the
 * id up globally is what makes held -> settled safe.
 */
async function findByImportedId(importedId) {
  await init();
  const { data } = await actual.aqlQuery(
    actual.q('transactions').filter({ imported_id: importedId }).select('*')
  );
  return (data && data[0]) || null;
}

async function updateTransactionFields(id, fields) {
  await init();
  return await actual.updateTransaction(id, fields);
}

async function getAccountsById() {
  await init();
  const accounts = await actual.getAccounts();
  return new Map(accounts.map((a) => [a.id, a]));
}

/** Payee that represents "transfer to <accountId>", used to create real transfers. */
async function getTransferPayee(accountId) {
  await init();
  const payees = await actual.getPayees();
  const payee = payees.find((p) => p.transfer_acct === accountId);
  return payee ? payee.id : null;
}

/**
 * Create a real Actual transfer. runTransfers must be true or only one leg is
 * written (importTransactions never runs transfer logic at all).
 */
async function addTransfer(fromAccountId, toAccountId, transaction) {
  await init();
  const accounts = await getAccountsById();
  for (const id of [fromAccountId, toAccountId]) {
    const acct = accounts.get(id);
    if (!acct) throw new Error(`transfer target ${id} does not exist`);
    if (acct.closed) throw new Error(`refusing to write a transfer into closed account "${acct.name}"`);
  }
  const payee = await getTransferPayee(toAccountId);
  if (!payee) throw new Error(`no transfer payee for account ${toAccountId}`);
  return await actual.addTransactions(fromAccountId, [{ ...transaction, payee }], { runTransfers: true });
}

/**
 * Candidate purchases a cover of `amount` could have paid for: same account,
 * matching absolute amount, inside the date window, not itself a cover/transfer
 * leg and not already absorbed onto a saver.
 */
async function findCoverCandidates({ accountId, amount, dateFrom, dateTo }) {
  await init();
  const [transactions, payees] = await Promise.all([
    actual.getTransactions(accountId, dateFrom, dateTo),
    actual.getPayees(),
  ]);
  const payeeName = new Map(payees.map((p) => [p.id, p.name || '']));
  const target = Math.abs(amount);

  return transactions.filter((t) => {
    if (!t.imported_id) return false;
    if (t.transfer_id) return false;
    if (t.starting_balance_flag) return false;
    if (Math.abs(t.amount) !== target) return false;
    const name = payeeName.get(t.payee) || '';
    if (/^(cover|transfer) /i.test(name)) return false;
    return true;
  });
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
  findByImportedId,
  updateTransactionFields,
  getAccountsById,
  getTransferPayee,
  addTransfer,
  findCoverCandidates,
  utils: actual.utils,
};
