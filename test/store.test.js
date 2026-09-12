const test = require('node:test');
const assert = require('node:assert/strict');
const { openStore } = require('../src/store');

test('questions round-trip and resolve once', () => {
  const s = openStore(':memory:');
  s.questions.add('abc', { kind: 'ambiguous', candidates: [{ id: 'x' }], amount: 100 });
  assert.equal(s.questions.countOpen(), 1);
  const q = s.questions.get('abc');
  assert.equal(q.kind, 'ambiguous');
  assert.deepEqual(q.candidates, [{ id: 'x' }]);
  assert.equal(s.questions.resolve('abc', 'picked:x'), true);
  assert.equal(s.questions.resolve('abc', 'keep'), false);
  assert.equal(s.questions.get('abc'), null);
  assert.equal(s.questions.countOpen(), 0);
});

test('events log and read back newest first', () => {
  const s = openStore(':memory:');
  s.events.log('up-1', { action: 'IMPORT', delivered: true });
  s.events.log('up-2', { action: 'DROP', delivered: false, reason: 'cover-sibling' });
  const recent = s.events.recent(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].upTxId, 'up-2');
  assert.equal(recent[0].delivered, false);
  assert.equal(recent[0].result.reason, 'cover-sibling');
  assert.equal(s.events.since('2000-01-01').length, 2);
});

test('migrations are idempotent on reopen', () => {
  const os = require('os');
  const path = require('path');
  const file = path.join(os.tmpdir(), `marvis-test-${process.pid}-${Date.now()}.db`);
  const a = openStore(file);
  a.questions.add('n1', { kind: 'no-match', candidates: [] });
  a.close();
  const b = openStore(file);
  assert.equal(b.questions.countOpen(), 1);
  b.close();
});
