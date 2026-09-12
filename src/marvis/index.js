/** Wire MARVIS to the importer's dependencies. One place to add modules. */
const { config } = require('../config');
const actual = require('../actual');
const { openStore } = require('../store');
const { createBot } = require('./bot');
const { createPendingStore } = require('./pending');
const { createFinanceModule } = require('./modules/finance');

const bot = createBot({ token: config.TELEGRAM_BOT_TOKEN, chatId: config.TELEGRAM_CHAT_ID });
const store = openStore(config.MARVIS_DB_PATH);
const pending = createPendingStore(store);
console.log(`[MARVIS] store ${store.path}`);

let finance = null;

async function init() {
  if (!bot.enabled) return;
  const accounts = await actual.listAccounts();
  const accountNames = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  finance = createFinanceModule({ actual, config, pending, send: bot.send, accountNames });
  bot.register(finance);
  await bot.start();
}

/** Safe to call from the webhook: never throws. Logs every outcome, asks when needed. */
async function afterImport(result, upInfo) {
  try {
    store.events.log(upInfo && upInfo.mapped && upInfo.mapped.imported_id, result);
  } catch (err) {
    console.error('[MARVIS] event log failed:', err);
  }
  if (!finance) return;
  try {
    await finance.afterImport(result, upInfo);
  } catch (err) {
    console.error('[MARVIS] notify failed:', err);
  }
}

async function stop() {
  await bot.stop();
  store.close();
}

module.exports = { init, afterImport, stop, store };
