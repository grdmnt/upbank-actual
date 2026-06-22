const axios = require('axios');
const { config } = require('./config');

const lm = axios.create({
  baseURL: 'https://dev.lunchmoney.app/v1',
  timeout: 10000,
  headers: {
    Authorization: `Bearer ${config.LUNCHMONEY_TOKEN}`,
    'User-Agent': 'upbank-actual-webhook/0.1',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

async function listAssets() {
  const res = await lm.get('/assets');
  return res.data?.assets || [];
}

async function createAsset(asset) {
  const res = await lm.post('/assets', asset);
  return res.data; // created asset object (has id)
}

async function listCategories() {
  const res = await lm.get('/categories', { params: { format: 'flattened' } });
  return res.data?.categories || [];
}

async function createCategory(category) {
  const res = await lm.post('/categories', category);
  return res.data; // { category_id }
}

/**
 * List transactions over a date range, following pagination.
 * Returns the flat array of transaction objects.
 */
async function listTransactions(params = {}) {
  const out = [];
  const limit = 500;
  let offset = 0;
  for (;;) {
    const res = await lm.get('/transactions', { params: { ...params, limit, offset } });
    const batch = res.data?.transactions || [];
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return out;
}

/**
 * Group transactions into a single transaction group (Lunch Money's transfer model).
 * `transactions` is an array of Lunch Money transaction ids. Returns the new group id.
 */
async function createTransactionGroup(group) {
  const res = await lm.post('/transactions/group', group);
  return res.data; // group id (number)
}

/**
 * Insert transactions into Lunch Money.
 * Dedupe is automatic per asset via external_id.
 * `options` overrides the default insert flags.
 * Returns { ids: [...] } on success.
 */
async function insertTransactions(transactions, options = {}) {
  const body = {
    transactions,
    // amounts are signed: negative = expense
    debit_as_negative: true,
    // external_id still dedupes regardless, but skip obvious dupes too
    skip_duplicates: true,
    apply_rules: true,
    check_for_recurring: true,
    ...options,
  };
  try {
    const res = await lm.post('/transactions', body);
    // Lunch Money returns 200 with an `error` array on validation failure
    if (res.data && Array.isArray(res.data.error) && res.data.error.length) {
      throw new Error(`Lunch Money insert error: ${res.data.error.join('; ')}`);
    }
    return res.data;
  } catch (error) {
    if (error.response?.status === 401) {
      console.error('[Lunch Money] 401 Unauthorized - check LUNCHMONEY_TOKEN');
    } else {
      console.error('[Lunch Money] insert failed:', error.response?.status, error.response?.data || error.message);
    }
    throw error;
  }
}

module.exports = {
  listAssets,
  createAsset,
  listCategories,
  createCategory,
  listTransactions,
  createTransactionGroup,
  insertTransactions,
};
