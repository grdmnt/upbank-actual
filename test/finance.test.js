const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinanceModule, stripTag } = require('../src/marvis/modules/finance');
const { createMemoryStore } = require('../src/marvis/pending');

const CONFIG = { ACCOUNT_MAP: { spending: 'upbank', groceries: 'pot-groceries' }, CHECK_COVER_NOTE: '#check-cover' };

function harness({ wideCandidates = [], existingLeg = null } = {}) {
  const sent = [];
  const calls = { updated: [], deleted: [] };
  const actual = {
    async findCoverCandidates() { return wideCandidates; },
    async updateTransactionFields(id, fields) { calls.updated.push({ id, fields }); },
    async findByImportedId() { return existingLeg; },
    async deleteTransaction(id) { calls.deleted.push(id); },
    async getOnBudgetBalances() { return [{ name: 'Up Bank', balance: 152259 }]; },
  };
  const pending = createMemoryStore();
  const send = async (text, extra) => { sent.push({ text, extra }); return { message_id: sent.length }; };
  const finance = createFinanceModule({ actual, config: CONFIG, pending, send, accountNames: { 'pot-groceries': '2Up Groceries' } });
  return { finance, sent, calls, pending };
}

const gyg = { id: 'gyg', date: '2026-08-18', amount: -1800, payee_name: 'Guzman y Gomez', category: 'eat-out' };
const amazon = { id: 'amazon', date: '2026-08-16', amount: -1800, payee_name: 'Amazon', category: null };

const ambiguousResult = {
  action: 'ABSORB', status: 'absorbed', ambiguous: true,
  purchaseId: 'gyg', movedTo: 'pot-groceries', candidates: [gyg, amazon], movedNotes: null,
};
const upInfo = { upAccountId: 'spending', mapped: { amount: 1800, imported_id: 'cover-1', date: '2026-08-19' } };

test('an ambiguous absorb asks with one button per candidate plus keep', async () => {
  const { finance, sent, pending } = harness();
  await finance.afterImport(ambiguousResult, upInfo);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\$18\.00 from 2Up Groceries/);
  const rows = sent[0].extra.reply_markup.inline_keyboard;
  assert.equal(rows.length, 3);
  assert.match(rows[0][0].text, /Guzman y Gomez/);
  assert.match(rows[2][0].text, /Keep/);
  assert.ok(rows[0][0].callback_data.length <= 64);
  assert.equal(pending.size(), 1);
});

test('picking the other candidate swaps the two purchases and clears the tag', async () => {
  const { finance, sent, calls, pending } = harness();
  await finance.afterImport(ambiguousResult, upInfo);
  const data = sent[0].extra.reply_markup.inline_keyboard[1][0].callback_data;

  const text = await finance.resolve(data);

  assert.match(text, /Amazon/);
  assert.deepEqual(calls.updated, [
    { id: 'gyg', fields: { account: 'upbank', notes: null } },
    { id: 'amazon', fields: { account: 'pot-groceries' } },
  ]);
  assert.equal(pending.size(), 0);
});

test('confirming the one already moved only strips the tag', async () => {
  const { finance, sent, calls } = harness();
  await finance.afterImport({ ...ambiguousResult, movedNotes: 'dinner' }, upInfo);
  const data = sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;

  await finance.resolve(data);

  assert.deepEqual(calls.updated, [{ id: 'gyg', fields: { notes: 'dinner' } }]);
});

test('keep leaves Actual untouched and closes the question', async () => {
  const { finance, sent, calls, pending } = harness();
  await finance.afterImport(ambiguousResult, upInfo);
  const data = sent[0].extra.reply_markup.inline_keyboard[2][0].callback_data;

  const text = await finance.resolve(data);

  assert.match(text, /Left as it was/);
  assert.deepEqual(calls.updated, []);
  assert.equal(pending.size(), 0);
});

test('a no-match cover searches 30 days back and replaces the transfer on pick', async () => {
  const { finance, sent, calls } = harness({ wideCandidates: [amazon], existingLeg: { id: 'transfer-leg' } });
  await finance.afterImport(
    { action: 'ABSORB_FALLBACK_TRANSFER', from: 'pot-groceries', to: 'upbank', coverImportedId: 'cover-1', amount: 1800, date: '2026-08-19' },
    upInfo
  );

  assert.match(sent[0].text, /recorded a plain transfer/);
  const data = sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
  await finance.resolve(data);

  assert.deepEqual(calls.deleted, ['transfer-leg']);
  assert.deepEqual(calls.updated, [{ id: 'amazon', fields: { account: 'pot-groceries' } }]);
});

test('a no-match cover with nothing in 30 days is informational, no buttons', async () => {
  const { finance, sent, pending } = harness({ wideCandidates: [] });
  await finance.afterImport(
    { action: 'ABSORB_FALLBACK_TRANSFER', from: 'pot-groceries', to: 'upbank', coverImportedId: 'cover-1', amount: 1800, date: '2026-08-19' },
    upInfo
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].extra, undefined);
  assert.equal(pending.size(), 0);
});

test('a stale or unknown nonce is answered without touching Actual', async () => {
  const { finance, calls } = harness();
  const text = await finance.resolve('cv:deadbeef:0');
  assert.match(text, /already been settled/);
  assert.deepEqual(calls.updated, []);
});

test('plain imports and drops send nothing', async () => {
  const { finance, sent } = harness();
  await finance.afterImport({ action: 'IMPORT', delivered: true }, upInfo);
  await finance.afterImport({ action: 'DROP', delivered: false }, upInfo);
  await finance.afterImport({ ...ambiguousResult, ambiguous: false }, upInfo);
  assert.equal(sent.length, 0);
});

test('/now reports balances and the pending count', async () => {
  const { finance, sent } = harness();
  await finance.afterImport(ambiguousResult, upInfo);
  const text = await finance.now();
  assert.match(text, /Up Bank: \$1,522\.59/);
  assert.match(text, /judgement: 1/);
  assert.equal(sent.length, 1);
});

test('stripTag removes only the tag', () => {
  assert.equal(stripTag('dinner #check-cover', '#check-cover'), 'dinner');
  assert.equal(stripTag('#check-cover', '#check-cover'), null);
  assert.equal(stripTag(null, '#check-cover'), null);
});
