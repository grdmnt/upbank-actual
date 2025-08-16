#!/usr/bin/env node
const { validateActualConfig } = require('../src/config');
const { listAccounts, shutdown } = require('../src/actual');

(async () => {
  try {
    validateActualConfig();
    const accounts = await listAccounts();
    console.log('Actual accounts:');
    for (const a of accounts) {
      console.log(`- ${a.name}  id=${a.id}`);
    }
    console.log('\nUse these ids in ACCOUNT_MAP, e.g.:');
    console.log('ACCOUNT_MAP={"<up-account-id>":"<actual-account-id>"}');
  } catch (e) {
    console.error('Failed to list accounts:', e);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
})();
