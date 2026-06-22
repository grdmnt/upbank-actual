#!/usr/bin/env node
/**
 * One-shot migration: Actual Budget -> Lunch Money.
 *
 * Copies accounts (-> assets), categories (-> categories) and transactions.
 * Idempotent: re-running reuses existing assets/categories matched by name and
 * relies on Lunch Money's per-asset external_id dedupe so transactions are not
 * imported twice (external_id = Actual transaction id).
 *
 * Env / flags:
 *   DRY_RUN=true          Report what would happen, write nothing
 *   START_DATE=YYYY-MM-DD  Earliest transaction date (default 2000-01-01)
 *   END_DATE=YYYY-MM-DD    Latest transaction date (default today)
 *   INCLUDE_CLOSED=true    Also migrate closed Actual accounts (default false)
 *   MIGRATE_CURRENCY=aud   ISO 4217 currency for created assets + transactions
 *   DEFAULT_ASSET_TYPE=cash  Lunch Money asset type_name (default cash)
 *
 * Requires Actual (ACTUAL_*) and Lunch Money (LUNCHMONEY_TOKEN) env vars.
 */
require('dotenv').config();
const { config } = require('../src/config');
const actual = require('../src/actual');
const lm = require('../src/lunchmoney');

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || 'false');
const INCLUDE_CLOSED = /^(1|true|yes)$/i.test(process.env.INCLUDE_CLOSED || 'false');
const START_DATE = process.env.START_DATE || '2000-01-01';
const END_DATE = process.env.END_DATE || new Date().toISOString().slice(0, 10);
const CURRENCY = (process.env.MIGRATE_CURRENCY || '').toLowerCase() || undefined;
const ASSET_TYPE = process.env.DEFAULT_ASSET_TYPE || 'cash';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GROUP_DELAY_MS = parseInt(process.env.GROUP_DELAY_MS || '350', 10);
const norm = (s) => String(s || '').trim().toLowerCase();
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const log = (...a) => console.log(...a);

function requireConfig() {
  if (!config.ACTUAL_ENABLED) {
    console.error('Actual not configured (ACTUAL_SERVER_URL / ACTUAL_PASSWORD / ACTUAL_BUDGET_ID).');
    process.exit(1);
  }
  if (!config.LUNCHMONEY_ENABLED) {
    console.error('Lunch Money not configured (LUNCHMONEY_TOKEN).');
    process.exit(1);
  }
}

async function migrateCategories() {
  const actualCats = await actual.getCategories(); // {id, name, group_id, is_income}
  const existing = await lm.listCategories();
  const byName = new Map(existing.filter((c) => !c.is_group).map((c) => [norm(c.name), c.id]));

  const map = new Map(); // actualCategoryId -> lmCategoryId
  let created = 0;
  for (const c of actualCats) {
    const key = norm(c.name);
    let lmId = byName.get(key);
    if (!lmId) {
      if (DRY_RUN) {
        log(`  [dry] create category "${c.name}"${c.is_income ? ' (income)' : ''}`);
        lmId = `dry:cat:${c.id}`; // placeholder so transactions can still be counted
      } else {
        const r = await lm.createCategory({ name: String(c.name).slice(0, 40), is_income: !!c.is_income });
        lmId = r.category_id;
        byName.set(key, lmId);
        created++;
      }
    }
    if (lmId) map.set(c.id, lmId);
  }
  log(`Categories: ${actualCats.length} in Actual, ${created} created in Lunch Money, ${map.size} mapped.`);
  return map;
}

async function migrateAccounts() {
  const accounts = await actual.listAccounts(); // {id, name, offbudget, closed, balance_current}
  const existing = await lm.listAssets();
  const byName = new Map(existing.map((a) => [norm(a.display_name || a.name), a.id]));

  const map = new Map(); // actualAccountId -> lmAssetId
  let created = 0;
  for (const acc of accounts) {
    if (acc.closed && !INCLUDE_CLOSED) {
      log(`  skip closed account "${acc.name}"`);
      continue;
    }
    const key = norm(acc.name);
    let assetId = byName.get(key);
    if (!assetId) {
      const balance = (((acc.balance_current || 0) / 100)).toFixed(4);
      const payload = {
        type_name: ASSET_TYPE,
        name: String(acc.name).slice(0, 45),
        balance,
        ...(CURRENCY ? { currency: CURRENCY } : {}),
        ...(acc.offbudget ? { exclude_transactions: true } : {}),
      };
      if (DRY_RUN) {
        log(`  [dry] create asset "${acc.name}" balance=${balance}`);
        assetId = `dry:asset:${acc.id}`; // placeholder so transactions can still be counted
      } else {
        const r = await lm.createAsset(payload);
        assetId = r.id;
        byName.set(key, assetId);
        created++;
      }
    }
    if (assetId) map.set(acc.id, assetId);
  }
  log(`Accounts: ${accounts.length} in Actual, ${created} assets created, ${map.size} mapped.`);
  return { accounts, assetMap: map };
}

function buildLmTransaction(tx, ctx) {
  const { assetId, payeeName, categoryId } = ctx;
  return {
    external_id: tx.id, // Actual uuid -> per-asset dedupe
    date: tx.date,
    amount: (tx.amount / 100).toFixed(2), // signed; debit_as_negative => negative = expense
    asset_id: assetId,
    payee: payeeName ? String(payeeName).slice(0, 140) : undefined,
    notes: tx.notes ? String(tx.notes).slice(0, 350) : undefined,
    category_id: categoryId || undefined,
    status: tx.cleared ? 'cleared' : 'uncleared',
    ...(CURRENCY ? { currency: CURRENCY } : {}),
  };
}

async function migrateTransactions({ accounts, assetMap }, categoryMap) {
  const payees = await actual.getPayees(); // {id, name, ...}
  const payeeName = new Map(payees.map((p) => [p.id, p.name]));

  let totalBuilt = 0;
  let totalInserted = 0;
  const errors = [];
  const transferPairs = new Map(); // sortedKey -> [actualIdA, actualIdB]

  for (const acc of accounts) {
    const assetId = assetMap.get(acc.id);
    if (!assetId) continue; // unmapped (e.g. closed + skipped)

    const txns = await actual.getTransactions(acc.id, START_DATE, END_DATE);
    const out = [];
    for (const tx of txns) {
      if (tx.is_child) continue; // children handled via their parent's subtransactions

      if (tx.is_parent && Array.isArray(tx.subtransactions) && tx.subtransactions.length) {
        for (const sub of tx.subtransactions) {
          out.push(buildLmTransaction(
            { ...sub, date: tx.date, cleared: tx.cleared },
            { assetId, payeeName: payeeName.get(tx.payee_id), categoryId: categoryMap.get(sub.category) }
          ));
        }
        continue;
      }

      // Record both legs of a transfer (linked by transfer_id) for later grouping
      if (tx.transfer_id) {
        const key = [tx.id, tx.transfer_id].sort().join('|');
        if (!transferPairs.has(key)) transferPairs.set(key, [tx.id, tx.transfer_id]);
      }

      out.push(buildLmTransaction(tx, {
        assetId,
        payeeName: payeeName.get(tx.payee_id),
        categoryId: categoryMap.get(tx.category),
      }));
    }

    totalBuilt += out.length;
    log(`  account "${acc.name}": ${out.length} transactions`);

    if (DRY_RUN || out.length === 0) continue;

    for (const batch of chunk(out, 500)) {
      try {
        // external_id already dedupes; don't let skip_duplicates drop legit same-amount txns
        const r = await lm.insertTransactions(batch, {
          skip_duplicates: false,
          apply_rules: false,
          check_for_recurring: false,
        });
        const n = Array.isArray(r?.ids) ? r.ids.length : 0;
        totalInserted += n;
        log(`    inserted ${n}/${batch.length} (account "${acc.name}")`);
      } catch (e) {
        errors.push({ account: acc.name, error: e.message });
        console.error(`    batch failed for "${acc.name}":`, e.message);
      }
    }
  }

  log(`Transactions: ${totalBuilt} built, ${totalInserted} inserted${DRY_RUN ? ' (dry run: 0 written)' : ''}.`);
  if (errors.length) log(`Errors: ${errors.length} batch(es) failed.`);

  return { transferPairs };
}

/**
 * Link transfer pairs in Lunch Money via transaction groups.
 * Resolves Actual tx ids -> Lunch Money ids by external_id (insert response only
 * carries ids for newly-created rows, so we query back to stay re-run safe).
 */
async function migrateTransfers(transferPairs) {
  if (transferPairs.size === 0) {
    log('Transfers: none found.');
    return;
  }
  if (DRY_RUN) {
    log(`Transfers: ${transferPairs.size} pair(s) would be grouped (dry run).`);
    return;
  }

  // Build external_id (Actual id) -> { id, group_id, date } over the migrated range,
  // descending into already-grouped parents to see their children.
  const byExternal = new Map();
  const index = (t) => {
    if (t.external_id) byExternal.set(t.external_id, { id: t.id, group_id: t.group_id, date: t.date });
    if (t.is_group && Array.isArray(t.children)) {
      for (const c of t.children) {
        if (c.external_id) byExternal.set(c.external_id, { id: c.id, group_id: t.id, date: c.date || t.date });
      }
    }
  };
  const all = await lm.listTransactions({ start_date: START_DATE, end_date: END_DATE });
  all.forEach(index);

  let grouped = 0;
  let skipped = 0;
  for (const [, [a, b]] of transferPairs) {
    const la = byExternal.get(a);
    const lb = byExternal.get(b);
    if (!la || !lb) { skipped++; continue; }           // a leg never landed in LM
    if (la.group_id || lb.group_id) { skipped++; continue; } // already grouped (re-run)

    let done = false;
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      try {
        await lm.createTransactionGroup({
          date: la.date || lb.date,
          payee: 'Transfer',
          notes: 'Migrated from Actual',
          transactions: [la.id, lb.id],
        });
        grouped++;
        done = true;
      } catch (e) {
        if (e?.response?.status === 429) {
          const retryAfter = parseInt(e.response.headers?.['retry-after'] || '0', 10);
          const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, attempt); // backoff
          log(`    429 rate-limited; waiting ${wait}ms (attempt ${attempt + 1}/5)`);
          await sleep(wait);
          continue;
        }
        skipped++;
        console.error(`    group failed for pair ${a}/${b}:`, e?.response?.data?.error || e.message);
        done = true;
      }
    }
    if (!done) { skipped++; console.error(`    group gave up after retries: ${a}/${b}`); }

    await sleep(GROUP_DELAY_MS); // throttle to stay under the rate limit
  }
  log(`Transfers: ${transferPairs.size} pair(s); ${grouped} grouped, ${skipped} skipped.`);
}

(async () => {
  requireConfig();
  log(`Migrating Actual -> Lunch Money${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log(`Date range: ${START_DATE} .. ${END_DATE}; include closed: ${INCLUDE_CLOSED}; currency: ${CURRENCY || 'default'}`);
  try {
    const categoryMap = await migrateCategories();
    const accountsCtx = await migrateAccounts();
    const { transferPairs } = await migrateTransactions(accountsCtx, categoryMap);
    await migrateTransfers(transferPairs);
    log('Done.');
  } catch (e) {
    console.error('Migration failed:', e?.response?.data || e);
    process.exitCode = 1;
  } finally {
    await actual.shutdown();
  }
})();
