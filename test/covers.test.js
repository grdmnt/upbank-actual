const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, ACTIONS } = require('../src/covers');

// Spending, Rent and Allocated all collapse into one Actual account; the shared
// 2Up savers get their own. `partner` is deliberately absent from the map: it is
// the other 2Up owner's account, which our token cannot read.
const MAP = {
  spending: 'upbank',
  rent: 'upbank',
  allocated: 'upbank',
  groceries: 'pot-groceries',
  eatout: 'pot-eatout',
};

const at = (description, amount, upAccountId, transferAccountId = null) =>
  classify({ description, amount, upAccountId, transferAccountId }, MAP);

test('ordinary transactions import', () => {
  assert.equal(at('Coles', -4348, 'spending').action, ACTIONS.IMPORT);
  // Real spend straight out of a saver - this is what was silently dropped before
  assert.equal(at('Showcase Realty', -300000, 'rent').action, ACTIONS.IMPORT);
  assert.equal(at('Interest', 71, 'groceries').action, ACTIONS.IMPORT);
});

test('covers between accounts that collapse into one Actual account drop both legs', () => {
  assert.equal(at('Cover from Allocated', 94451, 'spending', 'allocated').action, ACTIONS.DROP);
  assert.equal(at('Cover to Spending', -94451, 'allocated', 'spending').action, ACTIONS.DROP);
});

test('transfers within one Actual account drop both legs', () => {
  assert.equal(at('Transfer to Rent', -325000, 'spending', 'rent').action, ACTIONS.DROP);
  assert.equal(at('Transfer from Spending', 325000, 'rent', 'spending').action, ACTIONS.DROP);
});

test('a pot cover absorbs from the spending side and drops the saver side', () => {
  const spendingSide = at('Cover from Groceries', 4348, 'spending', 'groceries');
  assert.equal(spendingSide.action, ACTIONS.ABSORB);
  assert.equal(spendingSide.potAccountId, 'pot-groceries');
  assert.equal(spendingSide.potUpAccountId, 'groceries');

  const saverSide = at('Cover to Spending', -4348, 'groceries', 'spending');
  assert.equal(saverSide.action, ACTIONS.DROP);
  assert.equal(saverSide.reason, 'cover-sibling');
});

test("the other owner's cover imports against the pot", () => {
  const d = at('Cover to $shanescgng', -5875, 'groceries', 'partner');
  assert.equal(d.action, ACTIONS.IMPORT_FOREIGN_COVER);
  assert.equal(d.potAccountId, 'pot-groceries');
  assert.equal(d.potUpAccountId, 'groceries');
});

test('only the outgoing leg of a real transfer is imported', () => {
  const out = at('Transfer to Groceries', -75000, 'spending', 'groceries');
  assert.equal(out.action, ACTIONS.TRANSFER);
  assert.equal(out.toAccountId, 'pot-groceries');

  assert.equal(at('Transfer from Spending', 75000, 'groceries', 'spending').action, ACTIONS.DROP);
});

test('money arriving from an account we do not track is a plain import', () => {
  assert.equal(at('Transfer from $shanescgng', 10000, 'eatout', 'partner').action, ACTIONS.IMPORT);
  // Cover from a saver that is gone (closed) cannot be absorbed anywhere
  const stale = at('Cover from Tcg', 20480, 'spending', 'tcg-closed');
  assert.equal(stale.action, ACTIONS.IMPORT);
  assert.equal(stale.reason, 'cover-from-unmapped-account');
});

test('unmapped own account is skipped rather than guessed at', () => {
  assert.equal(at('anything', -100, 'not-in-map').action, ACTIONS.SKIP_UNMAPPED);
});

test('description matching is case and whitespace tolerant', () => {
  assert.equal(at('  cover from Groceries', 4348, 'spending', 'groceries').action, ACTIONS.ABSORB);
  assert.equal(at('COVER TO $shanescgng', -1000, 'groceries', 'partner').action, ACTIONS.IMPORT_FOREIGN_COVER);
});

test('a missing description still classifies by account topology', () => {
  assert.equal(classify({ amount: -100, upAccountId: 'spending' }, MAP).action, ACTIONS.IMPORT);
  assert.equal(
    classify({ amount: -100, upAccountId: 'spending', transferAccountId: 'rent' }, MAP).action,
    ACTIONS.DROP
  );
});
