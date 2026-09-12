const express = require('express');
const { config, validateConfig } = require('./config');
const { verifySignature, fetchTransaction, mapUpToActualTransaction, fetchAccounts } = require('./up');
const { listAccounts, shutdown } = require('./actual');
const { handleUpTransaction } = require('./importer');
const marvis = require('./marvis');

validateConfig();

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
    const upInfo = mapUpToActualTransaction(upTx);
    const result = await handleUpTransaction(upInfo);
    await marvis.afterImport(result, upInfo);

    console.log(
      `[Up] processed tx=${txId} action=${result.action} delivered=${result.delivered}` +
        (result.reason ? ` reason=${result.reason}` : '') +
        (result.status ? ` status=${result.status}` : '')
    );

    // 202 when nothing landed because the account is unmapped; a deliberate DROP is a 200
    const status = result.action === 'SKIP_UNMAPPED' ? 202 : 200;
    return res.status(status).json({ ok: true, delivered: result.delivered, result });
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
  marvis.init().catch((err) => console.error('[MARVIS] failed to start:', err));
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  server.close(async () => {
    await marvis.stop();
    await shutdown();
    process.exit(0);
  });
});
