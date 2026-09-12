/**
 * Repair history written before the cover logic existed.
 *
 * plan(): pull every Up transaction since REPAIR_SINCE, classify it exactly as
 * the webhook would, and compare with what Actual holds under that imported_id.
 * Raw cover/transfer legs get deleted; anything the handler would place
 * differently gets replayed through the very same handleUpTransaction.
 *
 * apply(): deletes first, then replays oldest first, so purchases are in place
 * before the covers that absorb them. Balances are preserved by construction:
 * every deleted leg is replaced by a moved purchase, a same-amount re-import,
 * or a real transfer. Idempotent: a second run finds nothing to do.
 */
const { classify, ACTIONS } = require('./covers');

const RAW_LEG = /^(undo cover|cover|transfer) /i;

function decide({ decision, existing, payeeName, config }) {
  const name = existing ? payeeName(existing.payee) : '';
  const rawLeg = existing && !existing.transfer_id && (RAW_LEG.test(name) || name === config.FOREIGN_COVER_PAYEE);

  switch (decision.action) {
    case ACTIONS.SKIP_UNMAPPED:
      return { op: 'skip', why: 'unmapped' };
    case ACTIONS.DROP:
      return rawLeg ? { op: 'delete', why: decision.reason } : { op: 'skip', why: existing ? 'not-a-raw-leg' : 'absent' };
    case ACTIONS.IMPORT:
      return existing ? { op: 'skip', why: 'present' } : { op: 'replay', why: 'missing' };
    case ACTIONS.ABSORB:
      return rawLeg ? { op: 'delete+replay', why: 'raw-cover-leg' } : existing ? { op: 'skip', why: 'not-a-raw-leg' } : { op: 'replay', why: 'absorb' };
    case ACTIONS.IMPORT_FOREIGN_COVER: {
      if (!existing) return { op: 'replay', why: 'missing' };
      const done = name === config.FOREIGN_COVER_PAYEE && existing.category;
      if (done) return { op: 'skip', why: 'repaired' };
      return rawLeg ? { op: 'delete+replay', why: 'raw-foreign-cover' } : { op: 'skip', why: 'not-a-raw-leg' };
    }
    case ACTIONS.TRANSFER:
      if (!existing) return { op: 'replay', why: 'missing' };
      if (existing.transfer_id) return { op: 'skip', why: 'linked' };
      return rawLeg ? { op: 'delete+replay', why: 'raw-transfer-leg' } : { op: 'skip', why: 'not-a-raw-leg' };
    default:
      return { op: 'skip', why: 'unknown' };
  }
}

function createRepair({ up, actual, config, handle, notify = async () => {} }) {
  async function plan(since = config.REPAIR_SINCE) {
    const [accounts, payees] = await Promise.all([up.fetchAccounts(), actual.getPayees()]);
    const payeeName = (id) => (payees.find((p) => p.id === id) || {}).name || '';

    const items = [];
    for (const account of accounts) {
      const txs = await up.fetchTransactionsSince(account.id, since);
      for (const t of txs) {
        const upInfo = up.mapUpToActualTransaction({ data: t });
        const decision = classify(
          { description: upInfo.description, amount: upInfo.mapped.amount, upAccountId: upInfo.upAccountId, transferAccountId: upInfo.transferAccountId },
          config.ACCOUNT_MAP
        );
        const existing = await actual.findByImportedId(upInfo.mapped.imported_id);
        const { op, why } = decide({ decision, existing, payeeName, config });
        items.push({ upInfo, decision, existing, op, why, createdAt: t.attributes.createdAt });
      }
    }
    items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    const counts = {};
    for (const it of items) counts[it.op] = (counts[it.op] || 0) + 1;
    return { since, items, counts, scanned: items.length };
  }

  async function apply(p) {
    const summary = { deleted: 0, replayed: 0, outcomes: {}, errors: [] };

    for (const it of p.items) {
      if (!it.op.startsWith('delete')) continue;
      try {
        await actual.deleteTransaction(it.existing.id);
        summary.deleted++;
      } catch (err) {
        summary.errors.push({ id: it.upInfo.mapped.imported_id, step: 'delete', message: err.message });
      }
    }

    for (const it of p.items) {
      if (!it.op.endsWith('replay')) continue;
      try {
        const result = await handle(it.upInfo);
        summary.replayed++;
        const key = result.status ? `${result.action}:${result.status}` : result.action;
        summary.outcomes[key] = (summary.outcomes[key] || 0) + 1;
        await notify(result, it.upInfo);
      } catch (err) {
        summary.errors.push({ id: it.upInfo.mapped.imported_id, step: 'replay', message: err.message });
      }
    }
    return summary;
  }

  return { plan, apply, decide };
}

module.exports = { createRepair, decide };
