/**
 * /repair: dry run, then Apply or Cancel. The plan lives in memory for the
 * life of the process; a stale button says so rather than acting on old data.
 */
const crypto = require('crypto');
const { voice } = require('../voice');

function createRepairModule({ repair, send, config }) {
  const plans = new Map();

  async function command() {
    await send(voice.repairScanning(config.REPAIR_SINCE));
    const p = await repair.plan();
    const nonce = crypto.randomBytes(4).toString('hex');
    plans.set(nonce, p);
    const todo = (p.counts['delete'] || 0) + (p.counts['replay'] || 0) + (p.counts['delete+replay'] || 0);
    if (!todo) return voice.repairNothing(p);
    return {
      text: voice.repairPlan(p),
      reply_markup: {
        inline_keyboard: [[
          { text: voice.applyButton(), callback_data: `rp:${nonce}:apply` },
          { text: voice.cancelButton(), callback_data: `rp:${nonce}:cancel` },
        ]],
      },
    };
  }

  async function callback(data) {
    const [, nonce, choice] = data.split(':');
    const p = plans.get(nonce);
    if (!p) return voice.stale();
    plans.delete(nonce);
    if (choice !== 'apply') return voice.repairCancelled();
    const summary = await repair.apply(p);
    return voice.repairDone(summary);
  }

  return {
    commands: { repair: { description: 'Fix rows written before cover handling existed', handler: command } },
    callbacks: { rp: callback },
  };
}

module.exports = { createRepairModule };
