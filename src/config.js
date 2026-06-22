const fs = require('fs');
const path = require('path');
require('dotenv').config();

function parseJsonEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`ENV ${name} must be valid JSON. Received:`, raw);
    process.exit(1);
  }
}

const config = {
  PORT: parseInt(process.env.PORT || '8080', 10),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Up webhook
  UP_WEBHOOK_SECRET: process.env.UP_WEBHOOK_SECRET || '',
  UP_API_TOKEN: process.env.UP_API_TOKEN || '',

  // Actual
  ACTUAL_SERVER_URL: process.env.ACTUAL_SERVER_URL || '',
  ACTUAL_PASSWORD: process.env.ACTUAL_PASSWORD || '',
  ACTUAL_BUDGET_ID: process.env.ACTUAL_BUDGET_ID || '',
  ACTUAL_BUDGET_ENCRYPTION_PASSWORD: process.env.ACTUAL_BUDGET_ENCRYPTION_PASSWORD || '',
  ACTUAL_DATA_DIR: process.env.ACTUAL_DATA_DIR || path.resolve(process.cwd(), '.actual-data'),

  // Lunch Money
  LUNCHMONEY_TOKEN: process.env.LUNCHMONEY_TOKEN || '',

  // Mapping
  ACCOUNT_MAP: parseJsonEnv('ACCOUNT_MAP', {}),
  // Map Up account IDs to Lunch Money asset IDs (JSON object)
  LM_ASSET_MAP: parseJsonEnv('LM_ASSET_MAP', {}),

  // Import options
  AMOUNT_FLIP: /^(1|true|yes)$/i.test(process.env.AMOUNT_FLIP || 'false'),
  LM_AMOUNT_FLIP: /^(1|true|yes)$/i.test(process.env.LM_AMOUNT_FLIP || 'false'),
};

// Which destinations are enabled (a token/config present)
config.ACTUAL_ENABLED = !!(config.ACTUAL_SERVER_URL && config.ACTUAL_PASSWORD && config.ACTUAL_BUDGET_ID);
config.LUNCHMONEY_ENABLED = !!config.LUNCHMONEY_TOKEN;

function validateActualConfig() {
  const missing = [];
  if (!config.ACTUAL_SERVER_URL) missing.push('ACTUAL_SERVER_URL');
  if (!config.ACTUAL_PASSWORD) missing.push('ACTUAL_PASSWORD');
  if (!config.ACTUAL_BUDGET_ID) missing.push('ACTUAL_BUDGET_ID');
  if (missing.length) {
    console.error('Missing Actual env vars:', missing.join(', '));
    console.error('Create a .env file based on .env.example');
    process.exit(1);
  }
  try {
    fs.mkdirSync(config.ACTUAL_DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn('Warning: could not ensure ACTUAL_DATA_DIR exists:', e.message);
  }
}

function validateUpConfig() {
  const missing = [];
  if (!config.UP_WEBHOOK_SECRET) missing.push('UP_WEBHOOK_SECRET');
  if (!config.UP_API_TOKEN) missing.push('UP_API_TOKEN');
  if (missing.length) {
    console.error('Missing Up env vars:', missing.join(', '));
    console.error('Create a .env file based on .env.example');
    process.exit(1);
  }
}

function validateLunchMoneyConfig() {
  if (!config.LUNCHMONEY_TOKEN) {
    console.error('Missing Lunch Money env var: LUNCHMONEY_TOKEN');
    process.exit(1);
  }
}

function validateConfig() {
  // Full validation for running the server
  validateUpConfig();

  if (!config.ACTUAL_ENABLED && !config.LUNCHMONEY_ENABLED) {
    console.error('No destination configured. Set Actual (ACTUAL_SERVER_URL/ACTUAL_PASSWORD/ACTUAL_BUDGET_ID) and/or Lunch Money (LUNCHMONEY_TOKEN).');
    process.exit(1);
  }

  if (config.ACTUAL_ENABLED) validateActualConfig();
  if (config.LUNCHMONEY_ENABLED) validateLunchMoneyConfig();
}

module.exports = { config, validateConfig, validateActualConfig, validateUpConfig, validateLunchMoneyConfig };
