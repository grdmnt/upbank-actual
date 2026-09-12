const test = require('node:test');
const assert = require('node:assert/strict');
const { handleUpTransaction } = require('../src/importer');

const CONFIG = {
  ACCOUNT_MAP: {
    spending: 'upbank',
    allocated: 'upbank',
    groceries: 'pot-groceries',
  },
  POT_CATEGORY_MAP: { groceries: 'cat-groceries' },
  FOREIGN_COVER_PAYEE: 'Shane Cover',
  FOREIGN_COVER_NOTE: '#update-payee',
  CHECK_COVER_NOTE: '#check-cover',
  ABSORB_WINDOW_DAYS: 3,
};

/** Records every write so tests can assert on what would hit Actual. */
function fakeActual({ existing = null, candidates = [], candidatesByAccount = null } = {}) {
  const calls = { imported: [], updated: [], transfers: [], candidateQueries: [] };
  return {
    calls,
    async findByImportedId() {
      return existing;
    },
    async updateTransactionFields(id, fields) {
      calls.updated.push({ id, fields });
    },
    async importTransactionsToActual(account, transactions) {
      calls.imported.push({ account, transactions });
      return { added: transactions.length };
    },
    async addTransfer(from, to, transaction) {
      calls.transfers.push({ from, to, transaction });
    },
    async findCoverCandidates(query) {
      calls.candidateQueries.push(query);
      if (candidatesByAccount) return candidatesByAccount[query.accountId] || [];
      return candidates;
    },
  };
}

const upInfo = (description, amount, upAccountId, transferAccountId = null, extra = {}) => ({
  mapped: {
    imported_id: 'up-tx-1',
    date: '2026-07-21',
    amount,
    payee_name: description,
    imported_payee: 'RAW TEXT',
    cleared: true,
    ...extra,
  },
  upAccountId,
  transferAccountId,
  description,
});

test('a plain purchase imports to the mapped account', async () => {
  const actual = fakeActual();
  const res = await handleUpTransaction(upInfo('Coles', -4348, 'spending'), { actual, config: CONFIG });

  assert.equal(res.delivered, true);
  assert.equal(actual.calls.imported.length, 1);
  assert.equal(actual.calls.imported[0].account, 'upbank');
});

test('dropped legs write nothing at all', async () => {
  const actual = fakeActual();
  const res = await handleUpTransaction(
    upInfo('Cover to Spending', -4348, 'allocated', 'spending'),
    { actual, config: CONFIG }
  );

  assert.equal(res.delivered, false);
  assert.deepEqual(actual.calls.imported, []);
  assert.deepEqual(actual.calls.transfers, []);
  assert.deepEqual(actual.calls.updated, []);
});

test('a transaction already imported anywhere is never imported twice', async () => {
  const actual = fakeActual({
    existing: { id: 'existing-1', account: 'pot-groceries', date: '2026-07-21', cleared: true },
  });
  const res = await handleUpTransaction(upInfo('Coles', -4348, 'spending'), { actual, config: CONFIG });

  assert.equal(res.status, 'already-imported');
  assert.deepEqual(actual.calls.imported, []);
});

test('settling updates the existing row in place, including one moved to a pot', async () => {
  // The held import landed on Up Bank, absorption moved it to the pot, now the
  // settled webhook arrives with a later date. Must update, not re-import.
  const actual = fakeActual({
    existing: { id: 'existing-1', account: 'pot-groceries', date: '2026-07-20', cleared: false },
  });
  const res = await handleUpTransaction(upInfo('Coles', -4348, 'spending'), { actual, config: CONFIG });

  assert.equal(res.status, 'updated');
  assert.deepEqual(actual.calls.updated, [
    { id: 'existing-1', fields: { date: '2026-07-21', cleared: true } },
  ]);
  assert.deepEqual(actual.calls.imported, []);
});

test('a pot cover moves the purchase it paid for onto the pot', async () => {
  const actual = fakeActual({
    candidates: [{ id: 'purchase-1', date: '2026-07-20', amount: -4348, notes: null }],
  });
  const res = await handleUpTransaction(
    upInfo('Cover from Groceries', 4348, 'spending', 'groceries'),
    { actual, config: CONFIG }
  );

  assert.equal(res.status, 'absorbed');
  assert.equal(res.ambiguous, false);
  assert.deepEqual(actual.calls.updated, [{ id: 'purchase-1', fields: { account: 'pot-groceries' } }]);
  // The cover legs themselves are never written
  assert.deepEqual(actual.calls.imported, []);
  assert.deepEqual(actual.calls.transfers, []);
});

test('the absorb window looks back ABSORB_WINDOW_DAYS and matches on absolute amount', async () => {
  const actual = fakeActual({ candidates: [{ id: 'p', date: '2026-07-20', amount: -4348 }] });
  await handleUpTransaction(upInfo('Cover from Groceries', 4348, 'spending', 'groceries'), {
    actual,
    config: CONFIG,
  });

  assert.deepEqual(actual.calls.candidateQueries[0], {
    accountId: 'upbank',
    amount: 4348,
    dateFrom: '2026-07-18',
    dateTo: '2026-07-21',
  });
});

test('two candidates: nearest preceding wins and gets tagged for review', async () => {
  const actual = fakeActual({
    candidates: [
      { id: 'older', date: '2026-07-19', amount: -2495, notes: null },
      { id: 'newer', date: '2026-07-21', amount: -2495, notes: 'dinner' },
    ],
  });
  const res = await handleUpTransaction(
    upInfo('Cover from Groceries', 2495, 'spending', 'groceries'),
    { actual, config: CONFIG }
  );

  assert.equal(res.ambiguous, true);
  assert.deepEqual(actual.calls.updated, [
    { id: 'newer', fields: { account: 'pot-groceries', notes: 'dinner #check-cover' } },
  ]);
});

test('no matching purchase falls back to a transfer that keeps the books right', async () => {
  const actual = fakeActual({ candidates: [] });
  const res = await handleUpTransaction(
    upInfo('Cover from Groceries', 4348, 'spending', 'groceries'),
    { actual, config: CONFIG }
  );

  assert.equal(res.action, 'ABSORB_FALLBACK_TRANSFER');
  assert.equal(actual.calls.transfers.length, 1);
  const [t] = actual.calls.transfers;
  assert.equal(t.from, 'pot-groceries');
  assert.equal(t.to, 'upbank');
  // Money leaves the pot, so the leg written on the pot must be negative
  assert.equal(t.transaction.amount, -4348);
  assert.match(t.transaction.notes, /#check-cover/);
  assert.equal(t.transaction.payee_name, undefined);
});

test("the other owner's cover imports with a fixed payee, the pot's category and a review tag", async () => {
  const actual = fakeActual();
  const res = await handleUpTransaction(
    upInfo('Cover to $shanescgng', -5875, 'groceries', 'partner-account'),
    { actual, config: CONFIG }
  );

  assert.equal(res.delivered, true);
  const [{ account, transactions }] = actual.calls.imported;
  assert.equal(account, 'pot-groceries');
  assert.equal(transactions[0].payee_name, 'Shane Cover');
  assert.equal(transactions[0].category, 'cat-groceries');
  assert.equal(transactions[0].notes, '#update-payee');
  // The raw description would just say "Cover to ..." - not a useful payee
  assert.equal(transactions[0].imported_payee, undefined);
});

test('a pot with no category configured still imports, uncategorised', async () => {
  const actual = fakeActual();
  const config = { ...CONFIG, POT_CATEGORY_MAP: {} };
  const res = await handleUpTransaction(
    upInfo('Cover to $shanescgng', -5875, 'groceries', 'partner-account'),
    { actual, config }
  );

  assert.equal(res.category, null);
  assert.equal(actual.calls.imported[0].transactions[0].category, undefined);
});

test('funding a pot writes one transfer leg, not two transactions', async () => {
  const actual = fakeActual();
  const res = await handleUpTransaction(
    upInfo('Transfer to Groceries', -75000, 'spending', 'groceries'),
    { actual, config: CONFIG }
  );

  assert.equal(res.action, 'TRANSFER');
  assert.deepEqual(actual.calls.imported, []);
  assert.equal(actual.calls.transfers.length, 1);
  assert.equal(actual.calls.transfers[0].from, 'upbank');
  assert.equal(actual.calls.transfers[0].to, 'pot-groceries');
  // Payee is set by the transfer itself; carrying the Up description would break it
  assert.equal(actual.calls.transfers[0].transaction.payee_name, undefined);
});

test('an unmapped account reports rather than writing somewhere arbitrary', async () => {
  const actual = fakeActual();
  const res = await handleUpTransaction(upInfo('Coles', -100, 'brand-new-saver'), {
    actual,
    config: CONFIG,
  });

  assert.equal(res.action, 'SKIP_UNMAPPED');
  assert.equal(res.delivered, false);
  assert.deepEqual(actual.calls.imported, []);
});

test('two candidates: the one in the pot\'s category wins without a tag', async () => {
  const actual = fakeActual({
    candidates: [
      { id: 'amazon', date: '2026-07-19', amount: -1800, notes: null, category: 'cat-groceries' },
      { id: 'gyg', date: '2026-07-21', amount: -1800, notes: null, category: 'cat-eat-out' },
    ],
  });
  const res = await handleUpTransaction(
    upInfo('Cover from Groceries', 1800, 'spending', 'groceries'),
    { actual, config: CONFIG }
  );

  assert.equal(res.ambiguous, false);
  assert.deepEqual(actual.calls.updated, [{ id: 'amazon', fields: { account: 'pot-groceries' } }]);
});

test('two candidates in the pot\'s category: nearest wins and is still tagged', async () => {
  const actual = fakeActual({
    candidates: [
      { id: 'older', date: '2026-07-19', amount: -1800, notes: null, category: 'cat-groceries' },
      { id: 'newer', date: '2026-07-20', amount: -1800, notes: null, category: 'cat-groceries' },
      { id: 'other', date: '2026-07-21', amount: -1800, notes: null, category: 'cat-eat-out' },
    ],
  });
  const res = await handleUpTransaction(
    upInfo('Cover from Groceries', 1800, 'spending', 'groceries'),
    { actual, config: CONFIG }
  );

  assert.equal(res.ambiguous, true);
  assert.deepEqual(actual.calls.updated, [
    { id: 'newer', fields: { account: 'pot-groceries', notes: '#check-cover' } },
  ]);
});

test('a re-delivered cover whose purchase already moved to the pot writes nothing', async () => {
  const actual = fakeActual({
    candidatesByAccount: {
      upbank: [],
      'pot-groceries': [{ id: 'purchase-1', date: '2026-07-20', amount: -4348 }],
    },
  });
  const res = await handleUpTransaction(
    upInfo('Cover from Groceries', 4348, 'spending', 'groceries'),
    { actual, config: CONFIG }
  );

  assert.equal(res.status, 'already-absorbed');
  assert.equal(res.purchaseId, 'purchase-1');
  assert.deepEqual(actual.calls.updated, []);
  assert.deepEqual(actual.calls.transfers, []);
  assert.deepEqual(actual.calls.imported, []);
});

test("the other owner undoing a cover reverses it under the same payee and category", async () => {
  const actual = fakeActual();
  const res = await handleUpTransaction(
    upInfo('Undo Cover to $partner', 3136, 'groceries', 'partner-spending'),
    { actual, config: CONFIG }
  );

  assert.equal(res.action, 'IMPORT_FOREIGN_COVER');
  const [{ account, transactions }] = actual.calls.imported;
  assert.equal(account, 'pot-groceries');
  assert.equal(transactions[0].amount, 3136);
  assert.equal(transactions[0].payee_name, 'Shane Cover');
  assert.equal(transactions[0].category, 'cat-groceries');
});
