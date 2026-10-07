/**
 * The finance agent behind MARVIS. Free text goes to the finance-agent service on
 * the host, which runs Claude and replies on Telegram itself (runs take a while,
 * so nothing here waits for them). Approval buttons it sends come back through
 * here because MARVIS owns the bot's inbound updates.
 */
const { voice } = require('../voice');

function createAgentModule({ url, token, fetchImpl = fetch, log = console }) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`agent ${method} ${path}: ${res.status}`);
    return res.json();
  };

  async function text(message) {
    try {
      await call('POST', '/chat', { text: message });
      return null;
    } catch (err) {
      log.error('[MARVIS] agent unreachable:', err.message);
      return voice.agentDown();
    }
  }

  async function approval(data) {
    const [, id, decision] = data.split(':');
    return voice.agentApproval(await call('POST', `/approval/${encodeURIComponent(id)}`, { decision }));
  }

  return {
    commands: {
      new: {
        description: 'Start a fresh conversation with the agent',
        handler: async () => {
          await call('POST', '/new');
          return voice.agentNew();
        },
      },
      jobs: {
        description: 'Scheduled jobs the agent runs',
        handler: async () => voice.agentJobs((await call('GET', '/jobs')).jobs),
      },
    },
    callbacks: { fa: approval },
    text,
  };
}

module.exports = { createAgentModule };
