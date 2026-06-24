const express = require('express');
const { config, validateConfig } = require('./config');
const { verifySignature, fetchTransaction, mapUpToActualTransaction, mapUpToLunchMoney, fetchAccounts } = require('./up');
const { importTransactionsToActual, listAccounts, shutdown } = require('./actual');
const lunchmoney = require('./lunchmoney');

validateConfig();

// Shift a YYYY-MM-DD string by n days (transfer legs can straddle midnight)
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Link the two legs of an Up cover/transfer into a Lunch Money transaction group.
 * Up sends each leg as a separate webhook with no counterpart-transaction id, so we
 * match the other leg by counterpart asset + |amount| + date window. Whichever leg's
 * webhook arrives second finds its partner and groups them; idempotent if re-delivered.
 */
async function linkLmTransfer({ mapped, upAccountId, transferAccountId }) {
  const ownAssetId = config.LM_ASSET_MAP[upAccountId];
  const counterpartAssetId = config.LM_ASSET_MAP[transferAccountId];
  if (!counterpartAssetId) {
    console.warn(`[Lunch Money] transfer counterpart account ${transferAccountId} not in LM_ASSET_MAP; leg imported unlinked`);
    return { linked: false, reason: 'counterpart-unmapped', transferAccountId };
  }

  const dateFrom = addDays(mapped.date, -1);
  const dateTo = addDays(mapped.date, 1);
  const amountAbs = Math.abs(parseFloat(mapped.amount));

  const self = await lunchmoney.findTransaction({
    assetId: ownAssetId, dateFrom, dateTo, externalId: mapped.external_id,
  });
  if (self && self.group_id) return { linked: true, alreadyGrouped: true, groupId: self.group_id };

  const counterpart = await lunchmoney.findTransaction({
    assetId: counterpartAssetId, dateFrom, dateTo, amountAbs,
    ungroupedOnly: true, excludeExternalId: mapped.external_id,
  });

  if (!self || !counterpart) {
    // The other leg hasn't been imported yet; its webhook will pair them.
    return { linked: false, reason: 'counterpart-not-found-yet' };
  }

  await lunchmoney.createTransactionGroup({
    date: mapped.date,
    payee: 'Transfer',
    notes: mapped.notes || 'Up transfer',
    transactions: [self.id, counterpart.id],
  });
  console.log(`[Lunch Money] grouped transfer legs ${self.id} + ${counterpart.id}`);
  return { linked: true, groupedIds: [self.id, counterpart.id] };
}

const app = express();

// Webhook route: must use raw body to verify signature
app.post('/webhook/up', express.raw({ type: ['application/json', 'application/*+json'] }), async (req, res) => {
  try {
    const sig = req.get('X-Up-Authenticity-Signature');
    if (!verifySignature(req.body, sig)) {
      console.warn('[Up] invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const eventType = payload?.data?.attributes?.eventType;
    const txIdLog = payload?.data?.relationships?.transaction?.data?.id;
    console.log(`[Up] event=${eventType || 'unknown'} tx=${txIdLog || '-'}`);
    // Acknowledge PING quickly with 200 (Up treats non-200 as failure)
    if (eventType === 'PING') {
      console.log('[Up] ping acknowledged');
      return res.status(200).json({ ok: true, eventType: 'PING' });
    }

    // Ignore other non-transaction events but still return 200
    if (!['TRANSACTION_CREATED', 'TRANSACTION_SETTLED', 'TRANSACTION_DELETED'].includes(eventType)) {
      console.log(`[Up] ignored event: ${eventType}`);
      return res.status(200).json({ ok: true, ignored: true, eventType });
    }

    const txRel = payload?.data?.relationships?.transaction?.data;
    const txId = txRel?.id;

    if (!txId) {
      console.warn('[Up] missing transaction id in payload');
      return res.status(400).json({ error: 'Missing transaction id in payload' });
    }

    if (eventType === 'TRANSACTION_DELETED') {
      // Nothing to do right now. Actual API could delete by id if we mapped, but we only know Up id.
      console.log(`[Up] deleted event tx=${txId}`);
      return res.status(200).json({ ok: true, skipped: 'deleted-event' });
    }

    const upTx = await fetchTransaction(txId);
    const results = {};
    let anyDelivered = false;
    let anyUnmapped = false;

    // --- Actual ---
    if (config.ACTUAL_ENABLED) {
      const { mapped, upAccountId } = mapUpToActualTransaction(upTx);
      const actualAccountId = config.ACCOUNT_MAP[upAccountId];
      if (!actualAccountId) {
        console.error('[Actual] no mapping for Up account', upAccountId);
        anyUnmapped = true;
        results.actual = { skipped: 'unmapped-account', upAccountId, hint: 'Add to ACCOUNT_MAP' };
      } else {
        console.log(`[Actual] importing tx=${mapped.imported_id} upAccount=${upAccountId} -> account=${actualAccountId}`);
        results.actual = await importTransactionsToActual(actualAccountId, [mapped]);
        anyDelivered = true;
      }
    }

    // --- Lunch Money ---
    if (config.LUNCHMONEY_ENABLED) {
      const { mapped, upAccountId, transferAccountId, isTransfer } = mapUpToLunchMoney(upTx);
      const assetId = config.LM_ASSET_MAP[upAccountId];
      if (!assetId) {
        console.error('[Lunch Money] no mapping for Up account', upAccountId);
        anyUnmapped = true;
        results.lunchmoney = { skipped: 'unmapped-account', upAccountId, hint: 'Add to LM_ASSET_MAP' };
      } else {
        mapped.asset_id = assetId;
        console.log(`[Lunch Money] inserting tx=${mapped.external_id} upAccount=${upAccountId} -> asset=${assetId}${isTransfer ? ' (transfer)' : ''}`);
        const insert = await lunchmoney.insertTransactions([mapped]);
        results.lunchmoney = insert;
        anyDelivered = true;

        // Cover/transfer: link the two legs into a Lunch Money transaction group
        if (isTransfer) {
          results.transfer = await linkLmTransfer({ mapped, upAccountId, transferAccountId });
        }
      }
    }

    console.log(`[Up] processed tx=${txId} delivered=${anyDelivered}`);

    // 202 if nothing landed because account was unmapped everywhere
    const status = anyDelivered ? 200 : (anyUnmapped ? 202 : 200);
    return res.status(status).json({ ok: true, delivered: anyDelivered, results });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Other routes can use JSON body parser
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/actual/accounts', async (req, res) => {
  try {
    const accounts = await listAccounts();
    res.json({ accounts });
  } catch (e) {
    console.error('List accounts error:', e);
    res.status(500).json({ error: 'Failed to list accounts' });
  }
});

app.get('/lunchmoney/assets', async (req, res) => {
  if (!config.LUNCHMONEY_ENABLED) {
    return res.status(404).json({ error: 'Lunch Money not configured' });
  }
  try {
    const assets = await lunchmoney.listAssets();
    res.json({ assets });
  } catch (e) {
    console.error('List Lunch Money assets error:', e?.response?.data || e);
    res.status(500).json({ error: 'Failed to list Lunch Money assets' });
  }
});

app.get('/up/accounts', async (req, res) => {
  try {
    const accounts = await fetchAccounts();
    res.json({ accounts });
  } catch (e) {
    console.error('List Up accounts error:', e?.response?.data || e);
    res.status(500).json({ error: 'Failed to list Up accounts' });
  }
});

const server = app.listen(config.PORT, () => {
  console.log(`Up→Actual webhook listening on :${config.PORT}`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  server.close(async () => {
    await shutdown();
    process.exit(0);
  });
});
