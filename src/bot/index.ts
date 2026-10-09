import { Bot } from 'grammy';
import type { BotContext, Deps } from './context.js';
import { auth } from './middleware/auth.js';
import { rateLimit } from './middleware/rate-limit.js';
import { commonHandlers } from './handlers/common.js';
import { adminHandlers } from './handlers/admin.js';
import { t } from '../texts/ru.js';

export function createBot(deps: Deps): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.config.BOT_TOKEN);

  bot.use(rateLimit());
  bot.use(auth(deps));
  bot.use(commonHandlers(deps));
  bot.use(adminHandlers(deps));

  bot.catch(async (err) => {
    // Без содержимого апдейта: только технические данные.
    deps.log.error({ updateId: err.ctx.update.update_id, err: (err.error as Error).message }, 'handler failed');
    await err.ctx.reply(t.internalError).catch(() => undefined);
  });

  return bot;
}
