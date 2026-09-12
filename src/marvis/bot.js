/**
 * MARVIS bot core: grammY transport, single-chat guard, module registry.
 *
 * Long polling, so nothing new is exposed to the internet. With no
 * TELEGRAM_BOT_TOKEN the bot is a no-op and the importer runs exactly as before.
 *
 * A module is { commands: { name: { description, handler } }, callbacks: { prefix: handler } }.
 * A command handler returns { text, reply_markup? } or a string. A callback handler
 * receives the callback data and returns the same; the originating message is edited.
 */
const { Bot } = require('grammy');
const { voice } = require('./voice');

const HTML = { parse_mode: 'HTML' };

const normalise = (out) => (typeof out === 'string' ? { text: out } : out || null);

function createBot({ token, chatId, log = console }) {
  if (!token) {
    log.log('[MARVIS] TELEGRAM_BOT_TOKEN not set, notifications disabled');
    return { enabled: false, send: async () => null, register() {}, start() {}, stop() {} };
  }

  const bot = new Bot(token);
  const modules = [];
  const allowed = chatId ? String(chatId) : null;

  const quickKeyboard = { keyboard: voice.quickKeys(), resize_keyboard: true, is_persistent: true };
  const reply = (ctx, out, extra = {}) => {
    const o = normalise(out);
    if (!o) return undefined;
    return ctx.reply(o.text, { ...HTML, ...extra, ...(o.reply_markup ? { reply_markup: o.reply_markup } : {}) });
  };

  // /whoami works before the chat id is configured, everything else is guarded
  bot.command('whoami', (ctx) => reply(ctx, voice.whoami(ctx.chat.id)));
  bot.use((ctx, next) => {
    if (!ctx.chat) return undefined;
    if (!allowed) return reply(ctx, voice.whoami(ctx.chat.id));
    if (String(ctx.chat.id) !== allowed) return reply(ctx, voice.notAuthorised());
    return next();
  });

  const commandList = () =>
    modules.flatMap((m) => Object.entries(m.commands || {}).map(([command, c]) => ({ command, description: c.description })));

  bot.command('start', (ctx) => reply(ctx, voice.start(), { reply_markup: quickKeyboard }));
  bot.command('help', (ctx) => reply(ctx, voice.help(commandList()), { reply_markup: quickKeyboard }));

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const prefix = data.split(':')[0];
    const handler = modules.map((m) => (m.callbacks || {})[prefix]).find(Boolean);
    if (!handler) return ctx.answerCallbackQuery();
    try {
      const o = normalise(await handler(data));
      if (o) await ctx.editMessageText(o.text, { ...HTML, ...(o.reply_markup ? { reply_markup: o.reply_markup } : {}) });
      await ctx.answerCallbackQuery();
    } catch (err) {
      // Telegram rejects an edit that changes nothing; that is not a failure
      if (/message is not modified/i.test(err.message || '')) return ctx.answerCallbackQuery();
      log.error('[MARVIS] callback failed:', err);
      await ctx.answerCallbackQuery({ text: voice.failed() });
    }
  });

  bot.catch((err) => log.error('[MARVIS] bot error:', err.error || err));

  const send = (text, extra = {}) => {
    if (!allowed) return null;
    return bot.api.sendMessage(allowed, text, { ...HTML, ...extra });
  };

  return {
    enabled: true,
    send,
    register(mod) {
      modules.push(mod);
      for (const [name, c] of Object.entries(mod.commands || {})) {
        const run = async (ctx) => {
          try {
            await reply(ctx, await c.handler());
          } catch (err) {
            log.error(`[MARVIS] /${name} failed:`, err);
            await reply(ctx, voice.failed());
          }
        };
        bot.command(name, run);
        // The quick keyboard sends the label as plain text
        bot.hears(new RegExp(`^${name}$`, 'i'), run);
      }
    },
    async start() {
      await bot.api.setMyCommands([
        ...commandList(),
        { command: 'help', description: 'What I can do' },
      ]);
      bot.start({ onStart: () => log.log('[MARVIS] listening') });
    },
    stop() {
      return bot.stop();
    },
  };
}

module.exports = { createBot };
