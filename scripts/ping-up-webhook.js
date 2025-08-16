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
      console.error('Usage: node scripts/ping-up-webhook.js <webhookId>');
      console.error('Example: npm run ping-up-webhook -- fc7a6d04-061a-4c99-a4bd-96ac35c66834');
      process.exit(1);
    }

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

    const res = await up.post(`/webhooks/${encodeURIComponent(webhookId)}/ping`, '');
    const evt = res.data?.data || {};
    const attrs = evt.attributes || {};
    const whId = evt.relationships?.webhook?.data?.id;

    console.log('Sent PING to webhook. Event returned:');
    console.log(`- event.id: ${evt.id}`);
    console.log(`- event.type: ${attrs.eventType}`);
    console.log(`- event.createdAt: ${attrs.createdAt}`);
    if (whId) console.log(`- webhook.id: ${whId}`);

    console.log('\nCheck your receiver logs or Up delivery logs if you did not observe a request:');
    console.log(`https://api.up.com.au/api/v1/webhooks/${encodeURIComponent(webhookId)}/logs`);
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error('Failed to ping Up webhook.', status ? `(HTTP ${status})` : '');
    if (data) {
      console.error(JSON.stringify(data, null, 2));
    } else {
      console.error(e?.message || e);
    }
    process.exit(1);
  }
})();
