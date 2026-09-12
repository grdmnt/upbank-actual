/**
 * Classify an Up transaction into the action the importer should take.
 *
 * Up models a "cover" (spend on Spending, paid for out of a Saver) as three
 * transactions: the purchase itself, a `Cover from <saver>` on Spending, and a
 * `Cover to Spending` on the saver. The two cover legs net to zero on Spending
 * and carry no merchant detail, so importing them verbatim produces noise.
 *
 * Everything is decided by resolving BOTH ends through ACCOUNT_MAP and
 * comparing the resulting Actual accounts — never by the Up account alone.
 * Pure function: no I/O, so the webhook and the backfill share one source of truth.
 */

const ACTIONS = {
  // Import as an ordinary transaction
  IMPORT: 'IMPORT',
  // Both legs resolve to the same Actual account, or the sibling leg handles it
  DROP: 'DROP',
  // Move the purchase this cover paid for onto the saver's account
  ABSORB: 'ABSORB',
  // A cover performed by the other 2Up owner: their purchase is invisible to us
  IMPORT_FOREIGN_COVER: 'IMPORT_FOREIGN_COVER',
  // Real movement between two different Actual accounts
  TRANSFER: 'TRANSFER',
  // Up account missing from ACCOUNT_MAP
  SKIP_UNMAPPED: 'SKIP_UNMAPPED',
};

const isCoverFrom = (d) => /^cover from /i.test(d);
const isCoverTo = (d) => /^cover to /i.test(d);
const isUndoCoverTo = (d) => /^undo cover to /i.test(d);

/**
 * @param {object} tx - { description, amount, upAccountId, transferAccountId }
 * @param {object} accountMap - Up account id -> Actual account id
 * @returns {{action: string, reason?: string, potAccountId?: string, potUpAccountId?: string, toAccountId?: string}}
 */
function classify(tx, accountMap) {
  const { description = '', amount, upAccountId, transferAccountId } = tx;

  const own = accountMap[upAccountId];
  if (!own) return { action: ACTIONS.SKIP_UNMAPPED, reason: 'own-account-unmapped' };

  // No counterpart: an ordinary purchase, refund, interest payment or external transfer
  if (!transferAccountId) return { action: ACTIONS.IMPORT, reason: 'plain' };

  const other = accountMap[transferAccountId];

  // Both ends live in the same Actual account (Spending <-> Rent <-> Allocated):
  // the two legs would cancel out inside one account, so neither is worth keeping.
  if (other && other === own) return { action: ACTIONS.DROP, reason: 'internal-to-account' };

  const d = String(description).trim();

  // Spending side of a cover. This is the side that can find the purchase.
  if (isCoverFrom(d)) {
    if (!other) return { action: ACTIONS.IMPORT, reason: 'cover-from-unmapped-account' };
    return { action: ACTIONS.ABSORB, potAccountId: other, potUpAccountId: transferAccountId };
  }

  // Saver side of a cover.
  if (isCoverTo(d)) {
    // Counterpart is one of our accounts, so the `Cover from` leg drives absorption.
    if (other) return { action: ACTIONS.DROP, reason: 'cover-sibling' };
    // Counterpart is unreadable => the other 2Up owner spent from a shared pot.
    return { action: ACTIONS.IMPORT_FOREIGN_COVER, potAccountId: own, potUpAccountId: upAccountId };
  }

  // The other owner undid a cover: reverse it under the same payee and category so
  // the pair nets to zero inside the pot's category instead of leaving an orphan.
  if (isUndoCoverTo(d) && !other) {
    return { action: ACTIONS.IMPORT_FOREIGN_COVER, reason: 'undo', potAccountId: own, potUpAccountId: upAccountId };
  }

  // Plain transfer to an account we do not track (e.g. partner funding a shared pot)
  if (!other) return { action: ACTIONS.IMPORT, reason: 'external-transfer' };

  // Real transfer between two tracked Actual accounts. Import only the outgoing
  // leg and let Actual generate the other side, otherwise we would create it twice.
  if (amount < 0) return { action: ACTIONS.TRANSFER, toAccountId: other };
  return { action: ACTIONS.DROP, reason: 'transfer-sibling' };
}

module.exports = { classify, ACTIONS };
