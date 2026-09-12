/**
 * MARVIS: Monty's Assistant for Routine, Very Important Stuff.
 * Every user-facing string lives here so the persona is tunable in one place.
 * Messages are HTML (parse_mode HTML); anything user-derived goes through esc().
 */
const money = (cents) => {
  const abs = Math.abs(cents) / 100;
  const s = abs.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
  return cents < 0 ? `-${s}` : s;
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Two-column monospace table: label left, value right-aligned. */
const table = (rows) => {
  const w1 = Math.max(...rows.map(([a]) => a.length));
  const w2 = Math.max(...rows.map(([, b]) => b.length));
  return '<code>' + rows.map(([a, b]) => `${esc(a.padEnd(w1))}  ${esc(b.padStart(w2))}`).join('\n') + '</code>';
};

const voice = {
  name: 'MARVIS',
  start: () =>
    '<b>MARVIS online.</b> Monty\'s Assistant for Routine, Very Important Stuff.\n\n' +
    'I keep the ledger honest and only interrupt when a decision is yours to make.\n' +
    'The buttons below are the quick way in. /help for the rest.',
  help: (commands) =>
    commands.map((c) => `/${c.command} — ${esc(c.description)}`).join('\n') +
    '\n/whoami — this chat\'s id, for configuration',
  whoami: (chatId) => `This chat is <code>${chatId}</code>. Set TELEGRAM_CHAT_ID to it and I shall speak only here.`,
  notAuthorised: () => 'I answer to one person, and it is not you.',

  ambiguousCover: ({ amount, potName, moved, candidates }) =>
    `Cover of <b>${money(amount)}</b> from ${esc(potName)}. I moved <b>${esc(moved.payee_name)}</b> (${moved.date}) onto the pot, ` +
    `but ${candidates.length} purchases match. Which one did it pay for?`,
  noMatchCover: ({ amount, potName, candidates }) =>
    `Cover of <b>${money(amount)}</b> from ${esc(potName)}. Nothing matched within the window, so I recorded a plain transfer. ` +
    (candidates.length
      ? `Older purchases of that amount, if one of these is it:`
      : `No purchase of that amount in the last 30 days either. Leaving it tagged.`),
  unmapped: ({ upAccountId }) => `A transaction arrived from Up account <code>${esc(upAccountId)}</code>, which is not in ACCOUNT_MAP. Skipped.`,

  // Button labels are plain text, Telegram does not parse them
  candidateButton: (c) => `${c.payee_name || 'Unknown'} · ${money(c.amount)} · ${c.date}`,
  keepButton: (kind) => (kind === 'no-match' ? 'Keep the transfer' : 'Keep as is'),
  refreshButton: () => 'Refresh',
  quickKeys: () => [['Now', 'Pending']],

  resolvedPick: (c) => `Done. <b>${esc(c.payee_name)}</b> (${c.date}) now sits on the pot, untagged.`,
  resolvedKeep: () => 'As you wish. Left as it was.',
  stale: () => 'That question has already been settled, or I have lost track of it. /pending will show what is still open.',

  now: ({ balances, pending, at }) =>
    '<b>Balances</b>\n' +
    table(balances.map((b) => [b.name, money(b.balance)])) +
    `\n\nAwaiting your judgement: <b>${pending}</b>` +
    (pending ? ' (/pending)' : '') +
    (at ? `\n<i>${esc(at)}</i>` : ''),
  nothingPending: () => 'Nothing awaits your judgement. A rare and pleasant state.',

  repairScanning: (since) => `Scanning Up since ${since} and comparing with the ledger. A moment.`,
  repairNothing: (p) => `Scanned ${p.scanned} transactions since ${p.since}. Nothing to repair.`,
  repairPlan: (p) =>
    `<b>Repair plan</b> (${p.scanned} scanned since ${p.since})\n` +
    table([
      ['Delete raw legs', String(p.counts['delete'] || 0)],
      ['Delete and replay', String(p.counts['delete+replay'] || 0)],
      ['Replay missing', String(p.counts['replay'] || 0)],
      ['Leave alone', String(p.counts['skip'] || 0)],
    ]) +
    '\n\nBalances stay as they are; only placement, payee and category change. Covers I cannot settle will come to you as questions. Take an export in Actual first if you want a belt with the braces.',
  repairCancelled: () => 'Cancelled. Nothing touched.',
  repairDone: (s) =>
    `<b>Repair done.</b> Deleted ${s.deleted}, replayed ${s.replayed}.\n` +
    table(Object.entries(s.outcomes).map(([k, v]) => [k, String(v)])) +
    (s.errors.length ? `\n\n<b>${s.errors.length} errors</b>\n<code>${esc(s.errors.slice(0, 5).map((e) => `${e.step} ${e.id}: ${e.message}`).join('\n'))}</code>` : ''),
  applyButton: () => 'Apply',
  cancelButton: () => 'Cancel',
  failed: () => 'That did not work. Check the logs.',
};

module.exports = { voice, money, esc, table };
