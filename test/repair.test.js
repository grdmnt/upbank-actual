const test = require('node:test');
const assert = require('node:assert/strict');
const { createRepair, decide } = require('../src/repair');
const { ACTIONS } = require('../src/covers');

const CONFIG = {
  ACCOUNT_MAP: { spending: 'upbank', groceries: 'pot-groceries', wedding: 'pot-wedding' },
  POT_CATEGORY_MAP: { groceries: 'cat-groceries' },
  FOREIGN_COVER_PAYEE: 'Shane Cover',
  REPAIR_SINCE: '2026-07-22',
};
const PAYEES = [
  { id: 'p-cover-from', name: 'Cover from Groceries' },
  { id: 'p-cover-to', name: 'Cover to Spending' },
  { id: 'p-shane-raw', name: 'Cover to $shanescgng' },
  { id: 'p-shane', name: 'Shane Cover' },
  { id: 'p-xfer', name: 'Transfer to Wedding Fund' },
  { id: 'p-woolies', name: 'Woolworths' },
];
const payeeName = (id) => (PAYEES.find((p) => p.id === id) || {}).name || '';

test('decide: raw cover legs are deleted, the Spending side also replays', () => {
  const d = (action, existing, reason) => decide({ decision: { action, reason }, existing, payeeName, config: CONFIG });
  assert.deepEqual(d(ACTIONS.DROP, { payee: 'p-cover-to' }, 'cover-sibling'), { op: 'delete', why: 'cover-sibling' });
  assert.deepEqual(d(ACTIONS.ABSORB, { payee: 'p-cover-from' }), { op: 'delete+replay', why: 'raw-cover-leg' });
  assert.deepEqual(d(ACTIONS.ABSORB, null), { op: 'replay', why: 'absorb' });
  // never delete something that does not look like a raw leg
  assert.deepEqual(d(ACTIONS.DROP, { payee: 'p-woolies' }, 'cover-sibling'), { op: 'skip', why: 'not-a-raw-leg' });
  assert.deepEqual(d(ACTIONS.ABSORB, { payee: 'p-cover-from', transfer_id: 'x' }), { op: 'skip', why: 'not-a-raw-leg' });
});

test('decide: partner covers are redone unless already payee and category', () => {
  const d = (existing) => decide({ decision: { action: ACTIONS.IMPORT_FOREIGN_COVER }, existing, payeeName, config: CONFIG });
  assert.deepEqual(d({ payee: 'p-shane-raw', category: null }), { op: 'delete+replay', why: 'raw-foreign-cover' });
  assert.deepEqual(d({ payee: 'p-shane', category: null }), { op: 'delete+replay', why: 'raw-foreign-cover' });
  assert.deepEqual(d({ payee: 'p-shane', category: 'cat-groceries' }), { op: 'skip', why: 'repaired' });
  assert.deepEqual(d(null), { op: 'replay', why: 'missing' });
});

test('decide: transfers are rebuilt only when unlinked; plain imports only when missing', () => {
  const d = (action, existing) => decide({ decision: { action }, existing, payeeName, config: CONFIG });
  assert.deepEqual(d(ACTIONS.TRANSFER, { payee: 'p-xfer' }), { op: 'delete+replay', why: 'raw-transfer-leg' });
  assert.deepEqual(d(ACTIONS.TRANSFER, { payee: 'p-xfer', transfer_id: 't' }), { op: 'skip', why: 'linked' });
  assert.deepEqual(d(ACTIONS.IMPORT, { payee: 'p-woolies' }), { op: 'skip', why: 'present' });
  assert.deepEqual(d(ACTIONS.IMPORT, null), { op: 'replay', why: 'missing' });
  assert.deepEqual(d(ACTIONS.SKIP_UNMAPPED, null), { op: 'skip', why: 'unmapped' });
});

const upTx = (id, account, description, cents, transferAccount, createdAt) => ({
  id,
  attributes: { description, amount: { valueInBaseUnits: cents }, status: 'SETTLED', createdAt, settledAt: createdAt },
  relationships: { account: { data: { id: account } }, ...(transferAccount ? { transferAccount: { data: { id: transferAccount } } } : {}) },
});

function harness({ existing = {}, txs = {} }) {
  const calls = { deleted: [], handled: [], notified: [] };
  const up = {
    async fetchAccounts() { return Object.keys(txs).map((id) => ({ id })); },
    async fetchTransactionsSince(accountId) { return txs[accountId] || []; },
    mapUpToActualTransaction: require('../src/up').mapUpToActualTransaction,
  };
  const actual = {
    async getPayees() { return PAYEES; },
    async findByImportedId(id) { return existing[id] || null; },
    async deleteTransaction(id) { calls.deleted.push(id); },
  };
  const handle = async (upInfo) => { calls.handled.push(upInfo.mapped.imported_id); return { action: 'ABSORB', status: 'absorbed', delivered: true }; };
  const notify = async (result, upInfo) => { calls.notified.push(upInfo.mapped.imported_id); };
  return { repair: createRepair({ up, actual, config: CONFIG, handle, notify }), calls };
}

test('plan then apply: deletes first, replays oldest first, notifies each replay', async () => {
  const { repair, calls } = harness({
    txs: {
      spending: [
        upTx('cover-from', 'spending', 'Cover from Groceries', 9831, 'groceries', '2026-09-09T12:31:00+10:00'),
        upTx('purchase', 'spending', 'Woolworths', -9831, null, '2026-09-08T18:44:00+10:00'),
      ],
      groceries: [
        upTx('cover-to', 'groceries', 'Cover to Spending', -9831, 'spending', '2026-09-09T12:31:00+10:00'),
        upTx('shane', 'groceries', 'Cover to $shanescgng', -2190, 'partner', '2026-09-11T20:39:00+10:00'),
      ],
    },
    existing: {
      'cover-from': { id: 'a-cf', payee: 'p-cover-from' },
      'cover-to': { id: 'a-ct', payee: 'p-cover-to' },
      purchase: { id: 'a-p', payee: 'p-woolies' },
      shane: { id: 'a-s', payee: 'p-shane-raw', category: null },
    },
  });

  const p = await repair.plan();
  assert.equal(p.scanned, 4);
  assert.deepEqual(p.counts, { 'delete+replay': 2, delete: 1, skip: 1 });

  const s = await repair.apply(p);
  assert.deepEqual(calls.deleted.sort(), ['a-cf', 'a-ct', 'a-s']);
  assert.deepEqual(calls.handled, ['cover-from', 'shane']);
  assert.deepEqual(calls.notified, ['cover-from', 'shane']);
  assert.equal(s.deleted, 3);
  assert.equal(s.replayed, 2);
  assert.deepEqual(s.outcomes, { 'ABSORB:absorbed': 2 });
  assert.deepEqual(s.errors, []);
});

test('a second plan over repaired data has nothing to do', async () => {
  const { repair, calls } = harness({
    txs: { groceries: [upTx('shane', 'groceries', 'Cover to $shanescgng', -2190, 'partner', '2026-09-11T20:39:00+10:00')] },
    existing: { shane: { id: 'a-s', payee: 'p-shane', category: 'cat-groceries' } },
  });
  const p = await repair.plan();
  assert.deepEqual(p.counts, { skip: 1 });
  await repair.apply(p);
  assert.deepEqual(calls.deleted, []);
  assert.deepEqual(calls.handled, []);
});
