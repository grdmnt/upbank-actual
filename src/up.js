const crypto = require('crypto');
const axios = require('axios');
const { config } = require('./config');

const up = axios.create({
  baseURL: 'https://api.up.com.au/api/v1',
  timeout: 10000,
  headers: {
    Authorization: `Bearer ${config.UP_API_TOKEN}`,
    'User-Agent': 'upbank-actual-webhook/0.1',
    Accept: 'application/json',
  },
});

function verifySignature(rawBodyBuffer, receivedSignatureHex) {
  if (!receivedSignatureHex) return false;
  const hmac = crypto.createHmac('sha256', config.UP_WEBHOOK_SECRET);
  hmac.update(rawBodyBuffer);
  const expectedHex = hmac.digest('hex');
  // timing safe compare
  try {
    const a = Buffer.from(receivedSignatureHex, 'hex');
    const b = Buffer.from(expectedHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

async function fetchTransaction(id) {
  const res = await up.get(`/transactions/${encodeURIComponent(id)}`);
  return res.data;
}

async function fetchAccounts() {
  // paginate just in case
  const data = [];
  let url = '/accounts';
  while (url) {
    const res = await up.get(url);
    data.push(...(res.data?.data || []));
    url = res.data?.links?.next || null;
  }
  return data;
}

function pickDate(attrs) {
  const ts = attrs.settledAt || attrs.createdAt;
  if (!ts) return null;
  // YYYY-MM-DD
  return String(ts).slice(0, 10);
}

function mapUpToActualTransaction(upTx) {
  const { id, attributes: attrs, relationships } = upTx.data;
  const upAccountId = relationships && relationships.account && relationships.account.data && relationships.account.data.id;

  const mapped = {
    imported_id: id,
    date: pickDate(attrs),
    amount: attrs.amount && typeof attrs.amount.valueInBaseUnits === 'number' ? attrs.amount.valueInBaseUnits : parseInt(attrs.amount.valueInBaseUnits, 10),
    payee_name: attrs.description || undefined,
    imported_payee: attrs.rawText || undefined,
    notes: attrs.message || undefined,
    cleared: attrs.status === 'SETTLED',
  };

  // Optional flip if user's Actual expects opposite sign
  if (config.AMOUNT_FLIP) mapped.amount = -mapped.amount;

  return { mapped, upAccountId };
}

module.exports = {
  verifySignature,
  fetchTransaction,
  fetchAccounts,
  mapUpToActualTransaction,
};
