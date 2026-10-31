import type { PayMode } from '@prisma/client';
import type { BotContext, Deps } from '../context.js';
import type { WizardDef } from './engine.js';
import { linkInput } from './helpers.js';
import { availableModes } from './pay-modes.js';
import { handleOrderError } from '../errors.js';
import { RenewalExistsError, type OrderWithClient } from '../../services/order-service.js';
import { o as ot } from '../../texts/orders.js';
import { r } from '../../texts/reports.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

interface RenewData {
  /** renew — продление подписки; reorder — повтор закрытой заявки. */
  kind: 'renew' | 'reorder';
  sourceId: number;
  clientId: number;
  needsUrl: boolean;
  url?: string;
  domain?: string;
  trusted?: boolean;
  risks?: string[];
  payMode?: PayMode;
}

export async function startRenew(ctx: BotContext, deps: Deps, source: OrderWithClient): Promise<void> {
  const existing = await deps.db.order.findFirst({
    where: { renewedFromId: source.id, status: { notIn: ['CANCELED', 'REJECTED'] } },
  });
  if (existing) return void (await ctx.reply(r.renewExists(existing.id)));
  if (!source.isSubscription || source.status !== 'DONE') return void (await ctx.reply(r.renewNotAllowed));
  // Ссылка нужна, если исходная заявка была со ссылкой: старая ссылка одноразовая и уже недействительна.
  const needsUrl = source.type !== 'GIFT_CARD' && (source.type !== 'OTHER' || !!source.url);
  deps.wizards.cancel(ctx.from!.id);
  await deps.wizards.start(ctx, renewWizard(deps), {
    kind: 'renew',
    sourceId: source.id,
    clientId: source.clientId,
    needsUrl,
  } satisfies RenewData);
}

/** Повтор закрытой заявки: те же данные, свежая ссылка и режим оплаты. */
export async function startReorder(ctx: BotContext, deps: Deps, source: OrderWithClient): Promise<void> {
  const repeatable =
    (source.status === 'DONE' && !source.isSubscription) ||
    source.status === 'CANCELED' ||
    source.status === 'REJECTED';
  if (!repeatable) return void (await ctx.reply(ot.reorderNotAllowed));
  const needsUrl = source.type !== 'GIFT_CARD' && (source.type !== 'OTHER' || !!source.url);
  deps.wizards.cancel(ctx.from!.id);
  await deps.wizards.start(ctx, renewWizard(deps), {
    kind: 'reorder',
    sourceId: source.id,
    clientId: source.clientId,
    needsUrl,
  } satisfies RenewData);
}

function renewWizard(deps: Deps): WizardDef<RenewData> {
  return {
    name: 'renew',
    steps: [
      {
        key: 'url',
        skip: (d) => !d.needsUrl,
        prompt: () => ({ text: ot.stepUrl(false) }),
        handle: async (input, d) => {
          const res = await linkInput(input, deps);
          if (!res.ok) return res.error;
          d.url = res.value.url;
          d.domain = res.value.domain;
          d.trusted = res.value.trusted;
          d.risks = res.value.risks;
          return undefined;
        },
      },
      {
        key: 'paymode',
        skip: async (d) => {
          if ((await availableModes(deps, d.clientId)).length > 1) return false;
          d.payMode = 'PREPAY';
          return true;
        },
        prompt: async (d) => ({
          text: ot.stepPayMode,
          buttons: (await availableModes(deps, d.clientId)).map((m) => [{ label: m.label, value: m.mode }]),
        }),
        handle: async (input, d) => {
          const chosen = (await availableModes(deps, d.clientId)).find((m) => m.mode === input.button);
          if (!chosen) return input.button ? ot.payModeUnavailable : ot.useButtons;
          d.payMode = chosen.mode;
          return undefined;
        },
      },
    ],
    finish: async (ctx, d) => {
      try {
        const over = {
          url: d.url ?? null,
          urlDomain: d.domain ?? null,
          linkRisk: d.risks?.length ? d.risks.join(';') : null,
          payMode: d.payMode ?? 'PREPAY',
        };
        const order =
          d.kind === 'renew'
            ? await deps.orders.renew(d.sourceId, d.clientId, over)
            : await deps.orders.reorder(d.sourceId, d.clientId, over);
        deps.log.info({ orderId: order.id, from: d.sourceId, kind: d.kind }, 'order created from existing');
        const extra = d.url && d.trusted === false ? `\n${ot.untrustedNote}` : '';
        await ctx.reply(
          `${d.kind === 'renew' ? r.renewCreated(order.id, d.sourceId) : ot.reorderCreated(order.id, d.sourceId)}${extra}`,
          html,
        );
        await deps.presenter.notifyAdmin(
          order,
          d.kind === 'renew' ? r.adminRenewal(d.sourceId) : ot.adminReorder(d.sourceId),
        );
      } catch (e) {
        if (e instanceof RenewalExistsError) return void (await ctx.reply(r.renewExists(e.order.id)));
        if (!(await handleOrderError(ctx, deps, e))) throw e;
      }
    },
  };
}
