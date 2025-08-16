#!/usr/bin/env node
require('dotenv').config();
const { fetchAccounts } = require('../src/up');

(async () => {
  try {
    if (!process.env.UP_API_TOKEN) {
      console.error('Missing UP_API_TOKEN in environment.');
      process.exit(1);
    }
    const accounts = await fetchAccounts();
    console.log('Up accounts:');
    for (const a of accounts) {
      const name = a?.attributes?.displayName || a?.attributes?.name || a?.id;
      const type = a?.attributes?.accountType || a?.attributes?.type || '';
      console.log(`- ${name}  id=${a.id}  type=${type}`);
    }
    console.log('\nUse these ids as keys in ACCOUNT_MAP, e.g.:');
    console.log('ACCOUNT_MAP={"<up-account-id>":"<actual-account-id>"}');
  } catch (e) {
    console.error('Failed to list Up accounts:', e?.response?.data || e);
    process.exit(1);
  }
})();
