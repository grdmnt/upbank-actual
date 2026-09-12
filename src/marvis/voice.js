/**
 * MARVIS: Monty's Assistant for Routine, Very Important Stuff.
 * Every user-facing string lives here so the persona is tunable in one place.
 */
const money = (cents) => {
  const abs = Math.abs(cents) / 100;
  const s = abs.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
  return cents < 0 ? `-${s}` : s;
};

const voice = {
  name: 'MARVIS',
  start: () =>
    'MARVIS online. Monty\'s Assistant for Routine, Very Important Stuff.\n\n' +
    'I keep the ledger honest and only interrupt when a decision is yours to make.\n' +
    'Commands: /now /pending /help',
  help: () =>
    '/now — balances and anything awaiting your judgement\n' +
    '/pending — re-send open questions\n' +
    '/whoami — this chat\'s id, for configuration',
  whoami: (chatId) => `This chat is ${chatId}. Set TELEGRAM_CHAT_ID to it and I shall speak only here.`,
  notAuthorised: () => 'I answer to one person, and it is not you.',

  ambiguousCover: ({ amount, potName, moved, candidates }) =>
    `Cover of ${money(amount)} from ${potName}. I moved ${moved.payee_name} (${moved.date}) onto the pot, ` +
    `but ${candidates.length} purchases match. Which one did it pay for?`,
  noMatchCover: ({ amount, potName, candidates }) =>
    `Cover of ${money(amount)} from ${potName}. Nothing matched within the window, so I recorded a plain transfer. ` +
    (candidates.length
      ? `Older purchases of that amount, if one of these is it:`
      : `No purchase of that amount in the last 30 days either. Leaving it tagged.`),
  unmapped: ({ upAccountId }) => `A transaction arrived from Up account ${upAccountId}, which is not in ACCOUNT_MAP. Skipped.`,

  candidateButton: (c) => `${c.payee_name || 'Unknown'} · ${money(c.amount)} · ${c.date}`,
  keepButton: (kind) => (kind === 'no-match' ? 'Keep the transfer' : 'Keep as is'),

  resolvedPick: (c) => `Done. ${c.payee_name} (${c.date}) now sits on the pot, untagged.`,
  resolvedKeep: () => 'As you wish. Left as it was.',
  stale: () => 'That question has already been settled, or I have lost track of it. /pending will show what is still open.',

  now: ({ balances, pending }) =>
    balances.map((b) => `${b.name}: ${money(b.balance)}`).join('\n') +
    `\n\nAwaiting your judgement: ${pending}` +
    (pending ? ' (/pending)' : ''),
  nothingPending: () => 'Nothing awaits your judgement. A rare and pleasant state.',
};

module.exports = { voice, money };
