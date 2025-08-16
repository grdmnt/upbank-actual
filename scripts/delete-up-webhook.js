#!/usr/bin/env node
require('dotenv').config();
const axios = require('axios');

(async () => {
  try {
    const token = process.env.UP_API_TOKEN;
    if (!token) {
      console.error('Missing UP_API_TOKEN in environment.');
      console.error('Set UP_API_TOKEN in your .env file.');
      process.exit(1);
    }

    const [, , webhookId] = process.argv;
    if (!webhookId) {
      console.error('Usage: node scripts/delete-up-webhook.js <webhookId>');
      console.error('Example: npm run delete-up-webhook -- 2ff06d42-efe6-4b14-83ea-bf8f4d6f4236');
      process.exit(1);
    }

    const up = axios.create({
      baseURL: 'https://api.up.com.au/api/v1',
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'upbank-actual-webhook/0.1',
        Accept: 'application/json',
      },
    });

    await up.delete(`/webhooks/${encodeURIComponent(webhookId)}`);
    console.log(`Deleted Up webhook: ${webhookId}`);
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error('Failed to delete Up webhook.', status ? `(HTTP ${status})` : '');
    if (data) {
      console.error(JSON.stringify(data, null, 2));
    } else {
      console.error(e?.message || e);
    }
    process.exit(1);
  }
})();
