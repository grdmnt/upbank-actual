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

    const [, , urlArg, ...descParts] = process.argv;
    if (!urlArg) {
      console.error('Usage: node scripts/create-up-webhook.js <webhookUrl> [description]');
      console.error('Example: npm run create-up-webhook -- https://your-host.example.com/webhook "Up → Actual bridge"');
      process.exit(1);
    }
    const description = (descParts.join(' ').trim()) || undefined;

    const up = axios.create({
      baseURL: 'https://api.up.com.au/api/v1',
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'upbank-actual-webhook/0.1',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    const body = { data: { attributes: { url: urlArg, description } } };

    const res = await up.post('/webhooks', body);
    const data = res.data?.data || {};
    const attrs = data.attributes || {};

    console.log('Created Up webhook:');
    console.log(`- id: ${data.id}`);
    console.log(`- url: ${attrs.url}`);
    if (attrs.description) console.log(`- description: ${attrs.description}`);
    if (attrs.createdAt) console.log(`- createdAt: ${attrs.createdAt}`);

    if (attrs.secretKey) {
      console.log('\nIMPORTANT: Save this secret now. It is only shown once.');
      console.log('Add to your .env as:');
      console.log(`UP_WEBHOOK_SECRET=${attrs.secretKey}`);
    } else {
      console.log('\nNote: secretKey was not present in the response. If this was not the initial creation response, the secret is not retrievable.');
    }

    console.log('\nTip: Configure your Up webhook to point at your running server (HTTPS recommended in production).');
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error('Failed to create Up webhook.', status ? `(HTTP ${status})` : '');
    if (data) {
      console.error(JSON.stringify(data, null, 2));
    } else {
      console.error(e?.message || e);
    }
    process.exit(1);
  }
})();
