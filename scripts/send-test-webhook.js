#!/usr/bin/env node
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

const WEBHOOK_URL = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 8080}/webhook/up`;
const SECRET = process.env.UP_WEBHOOK_SECRET;
const TX_ID = process.env.TX_ID || process.argv[2];
const EVENT = process.env.EVENT || 'TRANSACTION_CREATED';

if (!SECRET) {
  console.error('Missing UP_WEBHOOK_SECRET in env');
  process.exit(1);
}
if (!TX_ID) {
  console.error('Usage: TX_ID=<up-transaction-id> [WEBHOOK_URL=...] [EVENT=TRANSACTION_CREATED] node scripts/send-test-webhook.js');
  process.exit(1);
}

const payload = {
  data: {
    type: 'webhook-events',
    id: 'test-' + Date.now(),
    attributes: {
      eventType: EVENT,
      createdAt: new Date().toISOString(),
    },
    relationships: {
      webhook: { data: { type: 'webhooks', id: 'test' } },
      transaction: {
        data: { type: 'transactions', id: TX_ID },
      },
    },
  },
};

(async () => {
  const raw = Buffer.from(JSON.stringify(payload));
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(raw);
  const signature = hmac.digest('hex');

  try {
    const res = await axios.post(WEBHOOK_URL, raw, {
      headers: {
        'Content-Type': 'application/json',
        'X-Up-Authenticity-Signature': signature,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
    console.log('Status:', res.status);
    console.log('Response:', typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error('Request failed:', e?.response?.status, e?.response?.data || e.message);
    process.exit(1);
  }
})();
