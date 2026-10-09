import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { startRenew } from '../wizard/renew-flow.js';
import { o as ot } from '../../texts/orders.js';
import { r } from '../../texts/reports.js';

/** Кнопки из напоминаний о подписке: s:<id>:rn (продлить) и s:<id>:no (не продлевать). Только владелец-клиент. */
export function subscriptionHandlers(deps: Deps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  c.callbackQuery(/^s:(\d+):(rn|no)$/, async (ctx) => {
    const user = ctx.appUser;
    if (!user || user.role !== 'CLIENT') return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));
    const id = Number(ctx.match[1]);
    const order = await deps.orders.get(id);
    if (!order || order.clientId !== user.id) return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));

    const strip = () => ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    await ctx.answerCallbackQuery();

    if (ctx.match[2] === 'rn') {
      await startRenew(ctx, deps, order);
      return;
    }
    if (await deps.orders.stopSubscription(id, user.id)) {
      await strip();
      await ctx.reply(r.stopped(id));
      await deps.notifier.toAdmin(r.stoppedAdmin(id, user.id));
    } else {
      await strip();
      await ctx.reply(r.alreadyStopped);
    }
  });

  return c;
}
