/**
 * Finance module: turns importer outcomes that need a human into Telegram
 * questions with buttons, and applies the answer to Actual.
 *
 * Pure with respect to transport: `send` is injected, so tests use a recorder.
 * Callback data format: `cv:<nonce>:<index>` picks a candidate, `cv:<nonce>:keep`
 * leaves things as they are.
 */
const { voice } = require('../voice');

const WIDE_WINDOW_DAYS = 30;

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function stripTag(notes, tag) {
  if (!notes) return null;
  const out = notes.split(' ').filter((w) => w !== tag).join(' ').trim();
  return out || null;
}

function keyboard(nonce, candidates, kind) {
  const rows = candidates.map((c, i) => [{ text: voice.candidateButton(c), callback_data: `cv:${nonce}:${i}` }]);
  rows.push([{ text: voice.keepButton(kind), callback_data: `cv:${nonce}:keep` }]);
  return { inline_keyboard: rows };
}

function createFinanceModule({ actual, config, pending, send, accountNames = {} }) {
  const potName = (accountId) => accountNames[accountId] || 'a pot';

  async function ask(record, text) {
    const nonce = pending.add(record);
    const message = await send(text, { reply_markup: keyboard(nonce, record.candidates, record.kind) });
    return { nonce, message };
  }

  /** Called by the webhook after every import. Never throws into the webhook. */
  async function afterImport(result, upInfo) {
    if (result.action === 'ABSORB' && result.status === 'absorbed' && result.ambiguous) {
      const moved = result.candidates.find((c) => c.id === result.purchaseId);
      const record = {
        kind: 'ambiguous',
        potAccountId: result.movedTo,
        ownAccountId: config.ACCOUNT_MAP[upInfo.upAccountId],
        movedId: result.purchaseId,
        movedNotes: result.movedNotes,
        candidates: result.candidates,
        amount: upInfo.mapped.amount,
      };
      return ask(record, voice.ambiguousCover({ amount: record.amount, potName: potName(record.potAccountId), moved, candidates: record.candidates }));
    }

    if (result.action === 'ABSORB_FALLBACK_TRANSFER') {
      const candidates = await actual.findCoverCandidates({
        accountId: result.to,
        amount: result.amount,
        dateFrom: addDays(result.date, -WIDE_WINDOW_DAYS),
        dateTo: result.date,
      });
      const record = {
        kind: 'no-match',
        potAccountId: result.from,
        ownAccountId: result.to,
        coverImportedId: result.coverImportedId,
        candidates: candidates.map(({ id, date, amount, payee_name }) => ({ id, date, amount, payee_name })),
        amount: result.amount,
      };
      const text = voice.noMatchCover({ amount: record.amount, potName: potName(record.potAccountId), candidates: record.candidates });
      if (!record.candidates.length) return { message: await send(text) };
      return ask(record, text);
    }

    if (result.action === 'SKIP_UNMAPPED') {
      return { message: await send(voice.unmapped({ upAccountId: result.upAccountId })) };
    }

    return null;
  }

  /** Apply a button press. Returns the text the original message should be edited to. */
  async function resolve(data) {
    const [, nonce, choice] = String(data).split(':');
    const record = pending.get(nonce);
    if (!record) return voice.stale();

    if (choice === 'keep') {
      pending.resolve(nonce, 'keep');
      return voice.resolvedKeep();
    }

    const chosen = record.candidates[Number(choice)];
    if (!chosen) return voice.stale();

    if (record.kind === 'ambiguous') {
      if (chosen.id === record.movedId) {
        await actual.updateTransactionFields(record.movedId, { notes: stripTag(record.movedNotes ? `${record.movedNotes} ${config.CHECK_COVER_NOTE}` : config.CHECK_COVER_NOTE, config.CHECK_COVER_NOTE) });
      } else {
        await actual.updateTransactionFields(record.movedId, { account: record.ownAccountId, notes: record.movedNotes });
        await actual.updateTransactionFields(chosen.id, { account: record.potAccountId });
      }
    } else if (record.kind === 'no-match') {
      const leg = await actual.findByImportedId(record.coverImportedId);
      if (leg) await actual.deleteTransaction(leg.id);
      await actual.updateTransactionFields(chosen.id, { account: record.potAccountId });
    }

    pending.resolve(nonce, `picked:${chosen.id}`);
    return voice.resolvedPick(chosen);
  }

  async function now() {
    const balances = await actual.getOnBudgetBalances();
    const at = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    return {
      text: voice.now({ balances, pending: pending.size(), at }),
      reply_markup: { inline_keyboard: [[{ text: voice.refreshButton(), callback_data: 'now:refresh' }]] },
    };
  }

  /** Re-send every open question with fresh buttons. */
  async function resendPending() {
    const open = pending.list();
    if (!open.length) return send(voice.nothingPending());
    for (const item of open) {
      const text =
        item.kind === 'ambiguous'
          ? voice.ambiguousCover({ amount: item.amount, potName: potName(item.potAccountId), moved: item.candidates.find((c) => c.id === item.movedId) || {}, candidates: item.candidates })
          : voice.noMatchCover({ amount: item.amount, potName: potName(item.potAccountId), candidates: item.candidates });
      await send(text, { reply_markup: keyboard(item.nonce, item.candidates, item.kind) });
    }
    return null;
  }

  return {
    afterImport,
    resolve,
    now,
    resendPending,
    commands: {
      now: { description: 'Balances and anything awaiting your judgement', handler: now },
      pending: { description: 'Re-send open questions', handler: resendPending },
    },
    callbacks: { cv: resolve, now },
  };
}

module.exports = { createFinanceModule, stripTag };
