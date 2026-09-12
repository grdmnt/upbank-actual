#!/usr/bin/env node
/**
 * Read-only. Run every Up transaction since SINCE through covers.classify() and
 * print what the importer WOULD do. Nothing is written to Actual.
 *
 * Env: UP_API_TOKEN, ACCOUNT_MAP. Optional SINCE=2026-05-01, VERBOSE=true.
 */
require('dotenv').config();
const { config } = require('../src/config');
const { fetchAccounts, mapUpToActualTransaction } = require('../src/up');
const { classify } = require('../src/covers');
const axios = require('axios');

const SINCE = process.env.SINCE || '2026-05-01';
const VERBOSE = /^(1|true|yes)$/i.test(process.env.VERBOSE || 'false');

const up = axios.create({
  baseURL: 'https://api.up.com.au/api/v1',
  headers: { Authorization: `Bearer ${config.UP_API_TOKEN}` },
  timeout: 20000,
});

(async () => {
  const accounts = await fetchAccounts();
  const accountName = Object.fromEntries(accounts.map((a) => [a.id, a.attributes.displayName]));

  const rows = [];
  for (const account of accounts) {
    let url = `/accounts/${account.id}/transactions?page[size]=100&filter[since]=${encodeURIComponent(`${SINCE}T00:00:00+10:00`)}`;
    while (url) {
      const res = await up.get(url);
      for (const t of res.data.data) {
        const info = mapUpToActualTransaction({ data: t });
        const decision = classify(
          {
            description: info.description,
            amount: info.mapped.amount,
            upAccountId: info.upAccountId,
            transferAccountId: info.transferAccountId,
          },
          config.ACCOUNT_MAP
        );
        rows.push({ info, decision, accountName: accountName[info.upAccountId] });
      }
      url = res.data.links.next;
    }
  }

  const tally = {};
  for (const r of rows) {
    const key = `${r.decision.action}${r.decision.reason ? ` (${r.decision.reason})` : ''}`;
    tally[key] = tally[key] || { n: 0, sum: 0 };
    tally[key].n++;
    tally[key].sum += r.info.mapped.amount;
  }

  console.log(`${rows.length} Up transactions since ${SINCE}\n`);
  Object.entries(tally)
    .sort((a, b) => b[1].n - a[1].n)
    .forEach(([k, v]) => console.log(`${String(v.n).padStart(4)}  ${(v.sum / 100).toFixed(2).padStart(11)}   ${k}`));

  if (VERBOSE) {
    console.log('\n--- detail');
    rows
      .sort((a, b) => (a.info.mapped.date < b.info.mapped.date ? -1 : 1))
      .forEach((r) =>
        console.log(
          r.info.mapped.date,
          (r.info.mapped.amount / 100).toFixed(2).padStart(10),
          (r.accountName || '?').padEnd(16),
          r.decision.action.padEnd(22),
          JSON.stringify(r.info.description)
        )
      );
  }
})().catch((e) => {
  console.error('Failed:', e?.response?.data || e.message);
  process.exit(1);
});
