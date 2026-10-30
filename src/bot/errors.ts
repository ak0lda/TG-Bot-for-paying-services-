import type { BotContext, Deps } from './context.js';
import { formatRub } from '../domain/money.js';
import { InvalidTransitionError } from '../domain/order-fsm.js';
import {
  ForbiddenError,
  OrderDataError,
  OrderNotFoundError,
  PayLaterDeniedError,
  PayLaterLimitError,
  RequisitesNotAllowedError,
  RequisitesNotSentError,
  StaleOrderError,
} from '../services/order-service.js';
import { RateUnavailableError } from '../services/rates.js';
import { o as ot } from '../texts/orders.js';
import { safeError } from '../logging/safe-error.js';

const html = { parse_mode: 'HTML' as const };

/** Показывает актуальное состояние заявки тому, кто нажал устаревшую кнопку. */
export async function showCurrent(ctx: BotContext, deps: Deps, orderId: number): Promise<void> {
  const order = await deps.orders.get(orderId);
  if (!order) return void (await ctx.reply(ot.notFound));
  const view = ctx.appUser?.role === 'ADMIN' ? await deps.presenter.admin(order) : await deps.presenter.client(order);
  await ctx.reply(view.text, { ...html, reply_markup: view.keyboard, link_preview_options: { is_disabled: true } });
}

/** Предсказуемые ошибки операций с заявкой -> понятный ответ. true = ошибка обработана. */
export async function handleOrderError(ctx: BotContext, deps: Deps, e: unknown, orderId?: number): Promise<boolean> {
  if (e instanceof StaleOrderError) {
    await ctx.reply(ot.stale);
    await showCurrent(ctx, deps, e.order.id);
    return true;
  }
  if (e instanceof InvalidTransitionError) {
    await ctx.reply(ot.invalidAction);
    if (orderId) await showCurrent(ctx, deps, orderId);
    return true;
  }
  if (e instanceof RequisitesNotSentError) return (void (await ctx.reply(ot.noRequisitesYet)), true);
  if (e instanceof RequisitesNotAllowedError) return (void (await ctx.reply(ot.requisitesNotAllowed)), true);
  if (e instanceof PayLaterDeniedError) return (void (await ctx.reply(ot.payLaterDenied)), true);
  if (e instanceof PayLaterLimitError) {
    await ctx.reply(ot.payLaterLimit(formatRub(e.limitMinor), formatRub(e.exposureMinor)), html);
    return true;
  }
  if (e instanceof ForbiddenError) return (void (await ctx.reply(ot.forbidden)), true);
  if (e instanceof OrderNotFoundError) return (void (await ctx.reply(ot.notFound)), true);
  if (e instanceof RateUnavailableError) return (void (await ctx.reply(ot.rateErr(e.currency))), true);
  if (e instanceof OrderDataError) {
    deps.log.warn({ ...safeError(e) }, 'order data error');
    await ctx.reply(ot.invalidAction);
    return true;
  }
  return false;
}
