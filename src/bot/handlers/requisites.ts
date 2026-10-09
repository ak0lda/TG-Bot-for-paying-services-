import { Composer } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { startOrderRequisites, startTopUpRequisites } from '../wizard/requisites-flow.js';
import { startTopUpReceipt } from '../wizard/topup-flow.js';
import { b } from '../../texts/balance.js';
import { o as ot } from '../../texts/orders.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

/**
 * Реквизиты присылает админ:
 *  r:<заявка>:<версия>:<способ> — админ выбрал способ для заявки;
 *  p:<пополнение>:<способ>      — то же для пополнения;
 *  b:rc:<пополнение>            — клиент хочет отправить чек по пополнению.
 */
export function requisitesHandlers(deps: Deps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  c.callbackQuery(/^r:(\d+):(\d+):(\d+)$/, async (ctx) => {
    if (ctx.appUser?.role !== 'ADMIN') return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));
    const [id, version, methodId] = [Number(ctx.match[1]), Number(ctx.match[2]), Number(ctx.match[3])];
    const order = await deps.orders.get(id);
    if (!order) return void (await ctx.answerCallbackQuery({ text: ot.notFound }));
    if (order.version !== version || order.status !== 'AWAITING_PAYMENT') {
      await ctx.answerCallbackQuery({ text: ot.stale });
      const view = await deps.presenter.admin(order);
      return void (await ctx.reply(view.text, { ...html, reply_markup: view.keyboard }));
    }
    const method = await deps.catalog.getMethod(methodId);
    if (!method || !method.isActive) return void (await ctx.answerCallbackQuery({ text: ot.invalidAction }));
    await ctx.answerCallbackQuery();
    await startOrderRequisites(ctx, deps, order, method);
  });

  c.callbackQuery(/^p:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.appUser?.role !== 'ADMIN') return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));
    const topUp = await deps.topups.get(Number(ctx.match[1]));
    if (!topUp || topUp.status !== 'PENDING') return void (await ctx.answerCallbackQuery({ text: b.topUpAlready }));
    const method = await deps.catalog.getMethod(Number(ctx.match[2]));
    if (!method || !method.isActive) return void (await ctx.answerCallbackQuery({ text: ot.invalidAction }));
    await ctx.answerCallbackQuery();
    await startTopUpRequisites(ctx, deps, topUp, method);
  });

  c.callbackQuery(/^b:rc:(\d+)$/, async (ctx) => {
    if (ctx.appUser?.role !== 'CLIENT') return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));
    const topUp = await deps.topups.get(Number(ctx.match[1]));
    // Чужое или уже обработанное пополнение — одинаково «не найдено».
    if (!topUp || topUp.clientId !== ctx.appUser.id || topUp.status !== 'PENDING') {
      return void (await ctx.answerCallbackQuery({ text: b.receiptNotPending }));
    }
    // Чек принимается только после того, как админ прислал реквизиты.
    if (topUp.methodId == null) return void (await ctx.answerCallbackQuery({ text: ot.noRequisitesYet }));
    await ctx.answerCallbackQuery();
    await startTopUpReceipt(ctx, deps, topUp.id);
  });

  return c;
}
