/**
 * Open questions MARVIS has asked and not yet had answered.
 *
 * Telegram callback data is capped at 64 bytes, too small for two Actual ids,
 * so each question gets a short nonce and the details live here. Persisted to
 * a JSON file so a redeploy does not orphan the buttons already on your phone.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createPendingStore(filePath) {
  let items = {};
  try {
    items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    items = {};
  }

  function flush() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2));
  }

  return {
    add(record) {
      const nonce = crypto.randomBytes(4).toString('hex');
      items[nonce] = { ...record, createdAt: new Date().toISOString() };
      flush();
      return nonce;
    },
    get(nonce) {
      return items[nonce] || null;
    },
    remove(nonce) {
      delete items[nonce];
      flush();
    },
    list() {
      return Object.entries(items).map(([nonce, record]) => ({ nonce, ...record }));
    },
    size() {
      return Object.keys(items).length;
    },
  };
}

/** In-memory store for tests. */
function createMemoryStore() {
  const tmp = path.join(require('os').tmpdir(), `marvis-pending-${process.pid}-${Date.now()}.json`);
  return createPendingStore(tmp);
}

module.exports = { createPendingStore, createMemoryStore };
