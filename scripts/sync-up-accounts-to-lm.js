#!/usr/bin/env node
/**
 * Ensure every Up account has a matching Lunch Money asset, then print the full
 * LM_ASSET_MAP (Up account id -> LM asset id) to paste into your env.
 *
 * Needed so both legs of an Up cover/transfer (e.g. Spending <-> Saver/2Up) can
 * land in Lunch Money and be linked as a transfer.
 *
 * Env: UP_API_TOKEN, LUNCHMONEY_TOKEN. Optional DRY_RUN=true.
 */
require('dotenv').config();
const { fetchAccounts } = require('../src/up');
const lm = require('../src/lunchmoney');

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || 'false');
const norm = (s) => String(s || '').trim().toLowerCase();

(async () => {
  if (!process.env.UP_API_TOKEN) { console.error('Missing UP_API_TOKEN.'); process.exit(1); }
  if (!process.env.LUNCHMONEY_TOKEN) { console.error('Missing LUNCHMONEY_TOKEN.'); process.exit(1); }

  const upAccounts = await fetchAccounts();
  const existing = await lm.listAssets();
  const byName = new Map(existing.map((a) => [norm(a.display_name || a.name), a.id]));

  const map = {};
  let created = 0;
  for (const acc of upAccounts) {
    const attrs = acc.attributes || {};
    const name = attrs.displayName || acc.id;
    const balance = (((attrs.balance && attrs.balance.valueInBaseUnits) || 0) / 100).toFixed(4);
    const currency = attrs.balance && attrs.balance.currencyCode ? String(attrs.balance.currencyCode).toLowerCase() : undefined;

    let assetId = byName.get(norm(name));
    if (!assetId) {
      if (DRY_RUN) {
        console.log(`[dry] create LM asset "${name}" balance=${balance}`);
        assetId = `dry:${acc.id}`;
      } else {
        const r = await lm.createAsset({
          type_name: 'cash',
          name: String(name).slice(0, 45),
          balance,
          ...(currency ? { currency } : {}),
        });
        assetId = r.id;
        byName.set(norm(name), assetId);
        created++;
        console.log(`created LM asset "${name}" id=${assetId}`);
      }
    } else {
      console.log(`exists  LM asset "${name}" id=${assetId}`);
    }
    map[acc.id] = assetId;
  }

  console.log(`\n${upAccounts.length} Up accounts, ${created} LM assets created.`);
  console.log('\nLM_ASSET_MAP (paste into your env, e.g. Railway):');
  console.log(`LM_ASSET_MAP=${JSON.stringify(map)}`);
})().catch((e) => {
  console.error('Failed:', e?.response?.data || e.message);
  process.exit(1);
});
