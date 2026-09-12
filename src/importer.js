/**
 * Execute the action `covers.classify()` picked for an Up transaction.
 *
 * Shared by the webhook and the backfill so a replay behaves exactly like a live
 * event. Every write is guarded by a global `imported_id` lookup, which makes
 * re-delivery and held -> settled updates idempotent.
 */
const { config: defaultConfig } = require('./config');
const { classify, ACTIONS } = require('./covers');
const defaultActual = require('./actual');

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function withNote(mapped, note) {
  if (!note) return mapped;
  const notes = mapped.notes ? `${mapped.notes} ${note}` : note;
  return { ...mapped, notes };
}

/** Already imported anywhere? Refresh the fields that change on settlement. */
async function reconcileExisting(mapped, actual) {
  const existing = await actual.findByImportedId(mapped.imported_id);
  if (!existing) return null;

  const fields = {};
  if (existing.date !== mapped.date) fields.date = mapped.date;
  if (!existing.cleared && mapped.cleared) fields.cleared = true;
  if (Object.keys(fields).length) {
    await actual.updateTransactionFields(existing.id, fields);
    return { status: 'updated', id: existing.id, account: existing.account, fields };
  }
  return { status: 'already-imported', id: existing.id, account: existing.account };
}

/**
 * Move the purchase a cover paid for onto the saver's account, so the merchant
 * shows up where the money actually came from. Falls back to a plain transfer
 * when no single purchase can be identified.
 */
async function absorbCover({ mapped, ownAccountId, potAccountId, potCategoryId }, { actual, config }) {
  const dateTo = mapped.date;
  const dateFrom = addDays(mapped.date, -config.ABSORB_WINDOW_DAYS);

  const candidates = await actual.findCoverCandidates({
    accountId: ownAccountId,
    amount: mapped.amount,
    dateFrom,
    dateTo,
  });

  if (!candidates.length) {
    // The cover leg itself is never written, so a re-delivered webhook cannot be
    // recognised by imported_id. If a matching purchase already sits on the pot
    // inside the window, this cover was absorbed before: do nothing.
    const onPot = await actual.findCoverCandidates({ accountId: potAccountId, amount: mapped.amount, dateFrom, dateTo });
    if (onPot.length) return { status: 'already-absorbed', purchaseId: onPot[0].id };
    return { status: 'no-match' };
  }

  // Prefer the purchase whose category matches the pot; among those (or all, if
  // none match) the nearest at or before the cover wins. A single category match
  // is trusted, anything else is flagged rather than guessed at silently.
  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const inCategory = potCategoryId ? candidates.filter((c) => c.category === potCategoryId) : [];
  const pool = inCategory.length ? inCategory : candidates;
  const purchase = [...pool].sort(byDateDesc)[0];
  const ambiguous = inCategory.length === 1 ? false : candidates.length > 1;

  const fields = { account: potAccountId };
  if (ambiguous) {
    fields.notes = purchase.notes ? `${purchase.notes} ${config.CHECK_COVER_NOTE}` : config.CHECK_COVER_NOTE;
  }
  await actual.updateTransactionFields(purchase.id, fields);

  return {
    status: 'absorbed',
    purchaseId: purchase.id,
    movedTo: potAccountId,
    ambiguous,
    candidateCount: candidates.length,
    // Enough for a human to pick between them, and to undo the move if wrong
    candidates: candidates.map(({ id, date, amount, payee_name, category }) => ({ id, date, amount, payee_name, category })),
    movedNotes: purchase.notes || null,
  };
}

/**
 * @param {object} upInfo - result of mapUpToActualTransaction()
 * @returns {Promise<object>} a log-friendly record of what happened
 */
async function handleUpTransaction(upInfo, deps = {}) {
  const actual = deps.actual || defaultActual;
  const config = deps.config || defaultConfig;
  const { mapped, upAccountId, transferAccountId, description } = upInfo;

  const decision = classify(
    { description, amount: mapped.amount, upAccountId, transferAccountId },
    config.ACCOUNT_MAP
  );
  const ownAccountId = config.ACCOUNT_MAP[upAccountId];

  switch (decision.action) {
    case ACTIONS.SKIP_UNMAPPED:
      return { action: decision.action, delivered: false, upAccountId, hint: 'Add to ACCOUNT_MAP' };

    case ACTIONS.DROP:
      return { action: decision.action, delivered: false, reason: decision.reason };

    case ACTIONS.IMPORT: {
      const existing = await reconcileExisting(mapped, actual);
      if (existing) return { action: decision.action, delivered: true, ...existing };
      const result = await actual.importTransactionsToActual(ownAccountId, [mapped]);
      return { action: decision.action, delivered: true, account: ownAccountId, result };
    }

    case ACTIONS.IMPORT_FOREIGN_COVER: {
      const existing = await reconcileExisting(mapped, actual);
      if (existing) return { action: decision.action, delivered: true, ...existing };
      const category = config.POT_CATEGORY_MAP[decision.potUpAccountId];
      const tx = withNote(
        { ...mapped, payee_name: config.FOREIGN_COVER_PAYEE, imported_payee: undefined, ...(category ? { category } : {}) },
        config.FOREIGN_COVER_NOTE
      );
      const result = await actual.importTransactionsToActual(decision.potAccountId, [tx]);
      return { action: decision.action, delivered: true, account: decision.potAccountId, category: category || null, result };
    }

    case ACTIONS.TRANSFER: {
      const existing = await reconcileExisting(mapped, actual);
      if (existing) return { action: decision.action, delivered: true, ...existing };
      const { payee_name, imported_payee, ...rest } = mapped;
      await actual.addTransfer(ownAccountId, decision.toAccountId, rest);
      return { action: decision.action, delivered: true, from: ownAccountId, to: decision.toAccountId };
    }

    case ACTIONS.ABSORB: {
      const existing = await reconcileExisting(mapped, actual);
      if (existing) return { action: decision.action, delivered: true, ...existing, note: 'cover leg already present' };

      const outcome = await absorbCover(
        {
          mapped,
          ownAccountId,
          potAccountId: decision.potAccountId,
          potCategoryId: config.POT_CATEGORY_MAP[decision.potUpAccountId],
        },
        { actual, config }
      );
      if (outcome.status === 'absorbed' || outcome.status === 'already-absorbed') {
        return { action: decision.action, delivered: true, ...outcome };
      }

      // Could not identify the purchase: keep the books right by recording the
      // movement as a transfer, and flag it so the merchant can be fixed by hand.
      const { payee_name, imported_payee, ...rest } = mapped;
      await actual.addTransfer(decision.potAccountId, ownAccountId, {
        ...withNote(rest, config.CHECK_COVER_NOTE),
        amount: -mapped.amount,
      });
      return {
        action: 'ABSORB_FALLBACK_TRANSFER',
        delivered: true,
        from: decision.potAccountId,
        to: ownAccountId,
        coverImportedId: mapped.imported_id,
        amount: mapped.amount,
        date: mapped.date,
      };
    }

    default:
      return { action: 'UNKNOWN', delivered: false };
  }
}

module.exports = { handleUpTransaction, addDays };
