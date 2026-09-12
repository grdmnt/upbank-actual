/**
 * Open questions MARVIS has asked and not yet had answered.
 *
 * Telegram callback data is capped at 64 bytes, too small for two Actual ids,
 * so each question gets a short nonce and the details live in the store.
 */
const crypto = require('crypto');
const { openStore } = require('../store');

function createPendingStore(store) {
  return {
    add(record) {
      const nonce = crypto.randomBytes(4).toString('hex');
      return store.questions.add(nonce, record);
    },
    get: (nonce) => store.questions.get(nonce),
    resolve: (nonce, resolution) => store.questions.resolve(nonce, resolution),
    list: () => store.questions.listOpen(),
    size: () => store.questions.countOpen(),
  };
}

/** In-memory store for tests. */
function createMemoryStore() {
  return createPendingStore(openStore(':memory:'));
}

module.exports = { createPendingStore, createMemoryStore };
