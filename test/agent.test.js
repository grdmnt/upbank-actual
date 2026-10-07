const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentModule } = require('../src/marvis/modules/agent');

function harness(respond = () => ({ status: 200, body: {} })) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const call = { url, method: opts.method, auth: opts.headers.authorization, body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    const r = respond(call);
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  const log = { error() {} };
  return { agent: createAgentModule({ url: 'http://agent:8790', token: 'tkn', fetchImpl, log }), calls };
}

test('free text is forwarded and MARVIS stays quiet', async () => {
  const { agent, calls } = harness(() => ({ status: 202, body: { queued: 1 } }));
  assert.equal(await agent.text('suggest categories'), null);
  assert.deepEqual(calls, [{ url: 'http://agent:8790/chat', method: 'POST', auth: 'Bearer tkn', body: { text: 'suggest categories' } }]);
});

test('an unreachable agent is reported, not thrown', async () => {
  const { agent } = harness(() => new Error('ECONNREFUSED'));
  assert.match(await agent.text('hello'), /not answering/);
});

test('approval buttons post the decision and edit the message', async () => {
  const { agent, calls } = harness(() => ({ status: 200, body: { status: 'allow', summary: 'set-budget-amount Eat Out $300' } }));
  const out = await agent.callbacks.fa('fa:ab12:allow');
  assert.equal(calls[0].url, 'http://agent:8790/approval/ab12');
  assert.deepEqual(calls[0].body, { decision: 'allow' });
  assert.match(out, /Approved/);
  assert.match(out, /Eat Out \$300/);
});

test('jobs list shows schedule, paused and broken jobs', async () => {
  const jobs = [
    { name: 'weekly-food', schedule: '0 8 * * 1', enabled: true, nextRun: Date.parse('2026-10-11T21:00:00Z') },
    { name: 'old', schedule: '0 9 * * *', enabled: false },
    { name: 'bad', error: 'missing frontmatter' },
  ];
  const { agent } = harness(() => ({ status: 200, body: { jobs } }));
  const out = await agent.commands.jobs.handler();
  assert.match(out, /weekly-food.*0 8 \* \* 1.*next Mon/);
  assert.match(out, /old.*paused/);
  assert.match(out, /bad.*broken \(missing frontmatter\)/);
});
