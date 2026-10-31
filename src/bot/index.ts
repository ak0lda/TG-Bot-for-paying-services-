import { Bot } from 'grammy';
import type { BotContext, Deps } from './context.js';
import { auth } from './middleware/auth.js';
import { rateLimit } from './middleware/rate-limit.js';
import { commonHandlers } from './handlers/common.js';
import { adminHandlers } from './handlers/admin.js';
import { adminCatalogHandlers } from './handlers/admin-catalog.js';
import { adminReportHandlers } from './handlers/admin-reports.js';
import { bankMatchHandlers, handleBankText } from './handlers/bank-text.js';
import { requisitesHandlers } from './handlers/requisites.js';
import { subscriptionHandlers } from './handlers/subscriptions.js';
import { balanceHandlers } from './handlers/balance.js';
import { adminFinanceHandlers } from './handlers/admin-finance.js';
import { clientHandlers } from './handlers/client.js';
import { orderCallbacks } from './handlers/order-callbacks.js';
import { o as ot } from '../texts/orders.js';
import { t } from '../texts/ru.js';
import { safeError } from '../logging/safe-error.js';

export interface BotOptions {
  rateLimit?: { capacity: number; refillPerSec: number };
}

export function createBot(deps: Deps, opts: BotOptions = {}): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.config.BOT_TOKEN);

  bot.use(rateLimit(opts.rateLimit?.capacity, opts.rateLimit?.refillPerSec));
  bot.use(auth(deps));
  bot.use(commonHandlers(deps));
  bot.use(clientHandlers(deps));
  bot.use(adminHandlers(deps));
  bot.use(adminCatalogHandlers(deps));
  bot.use(adminFinanceHandlers(deps));
  bot.use(adminReportHandlers(deps));
  bot.use(requisitesHandlers(deps));
  bot.use(bankMatchHandlers(deps));
  bot.use(balanceHandlers(deps));
  bot.use(subscriptionHandlers(deps));
  bot.use(orderCallbacks(deps));

  // Кнопки диалогов (w:...)
  bot.callbackQuery(/^w:/, (ctx) => deps.wizards.onCallback(ctx));

  // Свободный ввод: сначала отдаём активному диалогу, команды в диалог не попадают.
  bot.on('message', async (ctx) => {
    if (ctx.message.text?.startsWith('/')) return void (await ctx.reply(ot.unknown));
    if (await deps.wizards.onMessage(ctx)) return;
    // Админ пересылает уведомление банка — ищем заявку и предлагаем подтвердить поступление.
    if (ctx.appUser?.role === 'ADMIN' && ctx.message.text && (await handleBankText(ctx, deps, ctx.message.text)))
      return;
    await ctx.reply(ot.unknown);
  });

  bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery({ text: ot.buttonStale }));

  bot.catch(async (err) => {
    // Без содержимого апдейта: только технические данные.
    deps.log.error({ updateId: err.ctx.update.update_id, ...safeError(err.error) }, 'handler failed');
    void deps.alerts.error(
      `handler:${safeError(err.error).err}`,
      'Ошибка в обработчике бота (клиент увидел «что-то пошло не так»)',
      err.error,
    );
    await err.ctx.reply(t.internalError).catch(() => undefined);
  });

  return bot;
}
