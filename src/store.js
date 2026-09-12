/**
 * MARVIS state: SQLite on the Railway volume.
 *
 * Two tables. `questions` holds every button-question ever asked, resolved rows
 * kept as an audit trail. `events` logs the outcome of every Up webhook, which
 * is what daily reports and the MCP tools read instead of Railway logs.
 *
 * Synchronous by design (better-sqlite3): the process is single-tenant and the
 * writes are tiny. Migrations are inline and idempotent.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS = [
  `create table if not exists questions (
     nonce       text primary key,
     kind        text not null,
     payload     text not null,
     created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     resolved_at text,
     resolution  text
   )`,
  `create index if not exists questions_open on questions (resolved_at) where resolved_at is null`,
  `create table if not exists events (
     id        integer primary key autoincrement,
     at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     up_tx_id  text,
     action    text not null,
     delivered integer not null,
     result    text not null
   )`,
  `create index if not exists events_at on events (at)`,
  `create index if not exists events_up_tx on events (up_tx_id)`,
];

function openStore(filePath) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  for (const sql of MIGRATIONS) db.exec(sql);

  const q = {
    insert: db.prepare('insert into questions (nonce, kind, payload) values (?, ?, ?)'),
    get: db.prepare('select * from questions where nonce = ? and resolved_at is null'),
    resolve: db.prepare(`update questions set resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolution = ? where nonce = ? and resolved_at is null`),
    listOpen: db.prepare('select * from questions where resolved_at is null order by created_at'),
    countOpen: db.prepare('select count(*) as n from questions where resolved_at is null'),
    insertEvent: db.prepare('insert into events (up_tx_id, action, delivered, result) values (?, ?, ?, ?)'),
    recentEvents: db.prepare('select * from events order by id desc limit ?'),
    eventsSince: db.prepare('select * from events where at >= ? order by id'),
  };

  const parseQuestion = (row) => (row ? { nonce: row.nonce, kind: row.kind, createdAt: row.created_at, ...JSON.parse(row.payload) } : null);
  const parseEvent = (row) => ({ id: row.id, at: row.at, upTxId: row.up_tx_id, action: row.action, delivered: !!row.delivered, result: JSON.parse(row.result) });

  return {
    questions: {
      add(nonce, record) {
        const { kind, ...payload } = record;
        q.insert.run(nonce, kind, JSON.stringify(payload));
        return nonce;
      },
      get: (nonce) => parseQuestion(q.get.get(nonce)),
      resolve: (nonce, resolution) => q.resolve.run(resolution, nonce).changes > 0,
      listOpen: () => q.listOpen.all().map(parseQuestion),
      countOpen: () => q.countOpen.get().n,
    },
    events: {
      log(upTxId, result) {
        q.insertEvent.run(upTxId || null, result.action || 'UNKNOWN', result.delivered ? 1 : 0, JSON.stringify(result));
      },
      recent: (n = 50) => q.recentEvents.all(n).map(parseEvent),
      since: (isoDate) => q.eventsSince.all(isoDate).map(parseEvent),
    },
    close: () => db.close(),
    path: filePath,
  };
}

module.exports = { openStore };
