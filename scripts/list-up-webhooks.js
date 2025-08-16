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

    const up = axios.create({
      baseURL: 'https://api.up.com.au/api/v1',
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'upbank-actual-webhook/0.1',
        Accept: 'application/json',
      },
    });

    let url = '/webhooks';
    const all = [];
    while (url) {
      const res = await up.get(url);
      const data = res.data;
      all.push(...(data?.data || []));
      url = data?.links?.next || null;
    }

    if (all.length === 0) {
      console.log('No webhooks configured.');
      return;
    }

    console.log('Up webhooks:');
    for (const w of all) {
      const attrs = w.attributes || {};
      const logsLink = w.relationships?.logs?.links?.related;
      console.log(`- id=${w.id}`);
      console.log(`  url=${attrs.url}`);
      if (attrs.description) console.log(`  description=${attrs.description}`);
      if (attrs.createdAt) console.log(`  createdAt=${attrs.createdAt}`);
      if (logsLink) console.log(`  logs=${logsLink}`);
    }

    console.log('\nDelete a webhook: npm run delete-up-webhook -- <webhookId>');
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error('Failed to list Up webhooks.', status ? `(HTTP ${status})` : '');
    if (data) {
      console.error(JSON.stringify(data, null, 2));
    } else {
      console.error(e?.message || e);
    }
    process.exit(1);
  }
})();
