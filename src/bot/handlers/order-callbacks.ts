import { Composer } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { InlineKeyboard } from 'grammy';
import { orderCb, parseOrderCb, type OrderAction } from '../callbacks.js';
import { rw, warningText } from '../../texts/rates.js';
import { handleOrderError } from '../errors.js';
import type { View } from '../presenter.js';
import { startConfirm, startNewLink, startPaid } from '../wizard/client-flows.js';
import { startReorder } from '../wizard/renew-flow.js';
import { startDone, startReject } from '../wizard/admin-flows.js';
import { ADMIN, CLIENT } from '../../services/order-service.js';
import { o as ot } from '../../texts/orders.js';

const ADMIN_ACTIONS: OrderAction[] = ['q', 'qf', 'pc', 'pn', 'lk', 'dn', 'rj'];
const CLIENT_ACTIONS: OrderAction[] = ['cf', 'pd', 'cx', 'nl', 'ro'];
const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

async function editView(ctx: BotContext, view: View): Promise<void> {
  await ctx.editMessageText(view.text, { ...html, reply_markup: view.keyboard }).catch(() => undefined); // «message is not modified» и т.п. — не критично
}

export function orderCallbacks(deps: Deps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  c.callbackQuery(/^o:/, async (ctx) => {
    const parsed = parseOrderCb(ctx.callbackQuery.data);
    const user = ctx.appUser;
    if (!parsed || !user) return void (await ctx.answerCallbackQuery({ text: ot.invalidAction }));
    const isAdmin = user.role === 'ADMIN';
    const { id, version, action } = parsed;

    if ((ADMIN_ACTIONS.includes(action) && !isAdmin) || (CLIENT_ACTIONS.includes(action) && isAdmin)) {
      return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));
    }
    const order = await deps.orders.get(id);
    if (!order) return void (await ctx.answerCallbackQuery({ text: ot.notFound }));
    if (!isAdmin && order.clientId !== user.id) return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));

    const viewOf = (o: typeof order) => (isAdmin ? deps.presenter.admin(o) : deps.presenter.client(o));

    if (action === 'v') {
      await ctx.answerCallbackQuery();
      const v = await viewOf(order);
      return void (await ctx.reply(v.text, { ...html, reply_markup: v.keyboard }));
    }

    // Идемпотентность: кнопка привязана к версии заявки. Любой переход меняет версию.
    if (order.version !== version) {
      await ctx.answerCallbackQuery({ text: ot.stale });
      return void (await editView(ctx, await viewOf(order)));
    }
    await ctx.answerCallbackQuery();

    try {
      switch (action) {
        case 'q':
        case 'qf':
        case 'rq': {
          // До расчёта проверяем курс: устарел / резко скачнул / ручной курс давно не обновлялся. Админ решает, считать ли.
          const assessment = order.currency ? await deps.rates.assess(order.currency) : null;
          const warnings = assessment?.warnings ?? [];
          if (isAdmin && action !== 'qf' && warnings.length > 0) {
            const kb = new InlineKeyboard()
              .text(rw.confirmBtn, orderCb(id, version, 'qf'))
              .row()
              .text(rw.cancelBtn, orderCb(id, version, 'v'));
            await ctx.reply(
              [rw.title(order.currency!, id), ...warnings.map((w) => warningText(w, order.currency!))].join('\n\n'),
              { reply_markup: kb },
            );
            break;
          }
          if (isAdmin && action === 'qf' && order.currency) await deps.rates.acknowledge(order.currency);
          const actor = isAdmin ? ADMIN(user.id) : CLIENT(user.id);
          const quoted = await deps.orders.requote(id, version, actor);
          await editView(ctx, await viewOf(quoted));
          if (isAdmin) await deps.presenter.notifyClient(quoted, ot.quoteReady(id));
          else {
            // Клиент пересчитывает сам — расчёт идёт в любом случае, но админ должен знать о предупреждениях по курсу.
            const note = warnings.length ? `\n${warnings.map((w) => warningText(w, order.currency!)).join('\n')}` : '';
            await deps.presenter.notifyAdmin(quoted, ot.adminRequoted(id) + note);
          }
          break;
        }
        case 'pc': {
          const o = await deps.orders.confirmPayment(id, version, user.id);
          await editView(ctx, await deps.presenter.admin(o));
          await deps.notifier.toClient(o.client.telegramId, ot.paymentConfirmed(id));
          break;
        }
        case 'pn': {
          const o = await deps.orders.paymentNotFound(id, version, user.id);
          await editView(ctx, await deps.presenter.admin(o));
          await deps.presenter.notifyClient(o, ot.paymentNotFound(id));
          break;
        }
        case 'lk': {
          const o = await deps.orders.markLinkInvalid(id, version, user.id);
          await editView(ctx, await deps.presenter.admin(o));
          await deps.presenter.notifyClient(o, ot.linkInvalidNotice(id));
          break;
        }
        case 'dn':
          deps.wizards.cancel(ctx.from!.id);
          await startDone(ctx, deps, order);
          break;
        case 'rj':
          deps.wizards.cancel(ctx.from!.id);
          await startReject(ctx, deps, order);
          break;
        case 'cf':
          deps.wizards.cancel(ctx.from!.id);
          await startConfirm(ctx, deps, order);
          break;
        case 'pd':
          deps.wizards.cancel(ctx.from!.id);
          await startPaid(ctx, deps, order);
          break;
        case 'ro':
          deps.wizards.cancel(ctx.from!.id);
          await startReorder(ctx, deps, order);
          break;
        case 'nl':
          deps.wizards.cancel(ctx.from!.id);
          await startNewLink(ctx, deps, order);
          break;
        case 'cx': {
          const o = await deps.orders.cancel(id, version, user.id);
          await editView(ctx, await deps.presenter.client(o));
          await deps.notifier.toAdmin(ot.adminCanceled(id, order.status === 'PAYMENT_CHECK'));
          break;
        }
        default:
          break;
      }
    } catch (e) {
      if (!(await handleOrderError(ctx, deps, e, id))) throw e;
    }
  });

  return c;
}
