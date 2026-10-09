import type { PaymentMethod } from '@prisma/client';
import type { BotContext, Deps } from '../context.js';
import { tryDelete, type WizardDef } from './engine.js';
import { handleOrderError } from '../errors.js';
import { deliverOrderRequisites, deliverTopUpRequisites, topUpAdminCard } from '../requisites.js';
import { formatRub } from '../../domain/money.js';
import type { OrderWithClient } from '../../services/order-service.js';
import { TopUpNotPendingError, type TopUpWithClient } from '../../services/topup-service.js';
import { b } from '../../texts/balance.js';
import { o as ot } from '../../texts/orders.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

type Target = { kind: 'order'; id: number; version: number } | { kind: 'topup'; id: number };

interface ReqData {
  target: Target;
  method: PaymentMethod;
  prompt: string;
  adminId: number;
  text?: string;
}

/** Админ выбрал способ для заявки -> просим прислать реквизиты. */
export async function startOrderRequisites(ctx: BotContext, deps: Deps, order: OrderWithClient, method: PaymentMethod): Promise<void> {
  deps.wizards.cancel(ctx.from!.id);
  await deps.wizards.start(ctx, requisitesWizard(deps), {
    target: { kind: 'order', id: order.id, version: order.version },
    method,
    prompt: ot.requisitesPrompt(method.title, formatRub(order.payDueMinor ?? order.totalMinor ?? 0n)),
    adminId: ctx.appUser!.id,
  });
}

export async function startTopUpRequisites(ctx: BotContext, deps: Deps, topUp: TopUpWithClient, method: PaymentMethod): Promise<void> {
  deps.wizards.cancel(ctx.from!.id);
  await deps.wizards.start(ctx, requisitesWizard(deps), {
    target: { kind: 'topup', id: topUp.id },
    method,
    prompt: b.topUpRequisitesPrompt(topUp.id, method.title, topUp.amountMinor),
    adminId: ctx.appUser!.id,
  });
}

function requisitesWizard(deps: Deps): WizardDef<ReqData> {
  return {
    name: 'requisites',
    steps: [
      {
        key: 'text',
        prompt: (d) => ({
          text: d.prompt,
          buttons: d.method.instructions ? [[{ label: ot.useSavedBtn, value: 'saved' }]] : [],
        }),
        handle: async (input, d, ctx) => {
          if (input.button === 'saved' && d.method.instructions) {
            d.text = d.method.instructions;
            return undefined;
          }
          const text = input.text?.trim();
          if (!text || text.length < 3 || text.length > 1000) return ot.requisitesBadText;
          d.text = text;
          // Реквизиты в чате админа не нужны — убираем сообщение (если Telegram позволяет).
          await tryDelete(ctx);
          return undefined;
        },
      },
    ],
    finish: async (ctx, d) => {
      const { target, method } = d;
      try {
        if (target.kind === 'order') {
          const order = await deps.orders.setPayMethod(target.id, target.version, d.adminId, method.id, method.title);
          await deliverOrderRequisites(deps, order, method, d.text!);
          const view = await deps.presenter.admin(order);
          await ctx.reply(`${ot.requisitesSent(order.id, method.title)}\n\n${view.text}`, { ...html, reply_markup: view.keyboard });
        } else {
          const topUp = await deps.topups.setMethod(target.id, method.id);
          await deliverTopUpRequisites(deps, topUp, method, d.text!);
          const card = await topUpAdminCard(deps, topUp);
          await ctx.reply(`${b.topUpRequisitesSent(topUp.id, method.title)}\n\n${card.text}`, { ...html, reply_markup: card.kb });
        }
      } catch (e) {
        if (e instanceof TopUpNotPendingError) return void (await ctx.reply(b.topUpAlready));
        if (!(await handleOrderError(ctx, deps, e, target.kind === 'order' ? target.id : undefined))) throw e;
      }
    },
  };
}
