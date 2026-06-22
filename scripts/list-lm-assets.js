#!/usr/bin/env node
require('dotenv').config();
const { listAssets } = require('../src/lunchmoney');

(async () => {
  try {
    if (!process.env.LUNCHMONEY_TOKEN) {
      console.error('Missing LUNCHMONEY_TOKEN in environment.');
      process.exit(1);
    }
    const assets = await listAssets();
    console.log('Lunch Money assets:');
    for (const a of assets) {
      const name = a?.display_name || a?.name || a?.id;
      console.log(`- ${name}  id=${a.id}  type=${a.type_name || ''}  currency=${a.currency || ''}`);
    }
    console.log('\nUse these ids as values in LM_ASSET_MAP, e.g.:');
    console.log('LM_ASSET_MAP={"<up-account-id>":<lunchmoney-asset-id>}');
  } catch (e) {
    console.error('Failed to list Lunch Money assets:', e?.response?.data || e);
    process.exit(1);
  }
})();
