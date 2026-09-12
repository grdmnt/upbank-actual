/**
 * MARVIS bot core: grammY transport, single-chat guard, module registry.
 *
 * Long polling, so nothing new is exposed to the internet. With no
 * TELEGRAM_BOT_TOKEN the bot is a no-op and the importer runs exactly as before.
 */
const { Bot } = require('grammy');
const { voice } = require('./voice');

function createBot({ token, chatId, log = console }) {
  if (!token) {
    log.log('[MARVIS] TELEGRAM_BOT_TOKEN not set, notifications disabled');
    return { enabled: false, send: async () => null, register() {}, start() {}, stop() {} };
  }

  const bot = new Bot(token);
  const modules = [];
  const allowed = chatId ? String(chatId) : null;

  // /whoami works before the chat id is configured, everything else is guarded
  bot.command('whoami', (ctx) => ctx.reply(voice.whoami(ctx.chat.id)));
  bot.use((ctx, next) => {
    if (!ctx.chat) return undefined;
    if (!allowed) return ctx.reply(voice.whoami(ctx.chat.id));
    if (String(ctx.chat?.id) !== allowed) return ctx.reply(voice.notAuthorised());
    return next();
  });

  bot.command('start', (ctx) => ctx.reply(voice.start()));
  bot.command('help', (ctx) => ctx.reply(voice.help()));

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const mod = modules.find((m) => m.callbackPrefix && data.startsWith(m.callbackPrefix));
    if (!mod) return ctx.answerCallbackQuery();
    try {
      const text = await mod.resolve(data);
      await ctx.editMessageText(text);
      await ctx.answerCallbackQuery();
    } catch (err) {
      log.error('[MARVIS] callback failed:', err);
      await ctx.answerCallbackQuery({ text: 'That did not work. Check the logs.' });
    }
  });

  bot.catch((err) => log.error('[MARVIS] bot error:', err.error || err));

  const send = (text, extra = {}) => {
    if (!allowed) return null;
    return bot.api.sendMessage(allowed, text, extra);
  };

  return {
    enabled: true,
    send,
    register(mod) {
      modules.push(mod);
      for (const [name, handler] of Object.entries(mod.commands || {})) {
        bot.command(name, async (ctx) => {
          try {
            const text = await handler();
            if (text) await ctx.reply(text);
          } catch (err) {
            log.error(`[MARVIS] /${name} failed:`, err);
            await ctx.reply('That did not work. Check the logs.');
          }
        });
      }
    },
    start() {
      bot.start({ onStart: () => log.log('[MARVIS] listening') });
    },
    stop() {
      return bot.stop();
    },
  };
}

module.exports = { createBot };
