/** Wire MARVIS to the importer's dependencies. One place to add modules. */
const path = require('path');
const { config } = require('../config');
const actual = require('../actual');
const { createBot } = require('./bot');
const { createPendingStore } = require('./pending');
const { createFinanceModule } = require('./modules/finance');

const bot = createBot({ token: config.TELEGRAM_BOT_TOKEN, chatId: config.TELEGRAM_CHAT_ID });
const pending = createPendingStore(path.join(config.ACTUAL_DATA_DIR, 'marvis-pending.json'));

let finance = null;

async function init() {
  if (!bot.enabled) return;
  const accounts = await actual.listAccounts();
  const accountNames = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  finance = createFinanceModule({ actual, config, pending, send: bot.send, accountNames });
  bot.register(finance);
  await bot.start();
}

/** Safe to call from the webhook: never throws. */
async function afterImport(result, upInfo) {
  if (!finance) return;
  try {
    await finance.afterImport(result, upInfo);
  } catch (err) {
    console.error('[MARVIS] notify failed:', err);
  }
}

module.exports = { init, afterImport, stop: () => bot.stop() };
