import type { AdminCard } from '@prisma/client';
import type { BotContext, Deps } from '../context.js';
import { tryDelete, type WizardDef } from './engine.js';
import { freeText } from './helpers.js';
import { handleOrderError } from '../errors.js';
import { notifyOrderDone } from '../notify-done.js';
import { MoneyParseError, formatMinor, formatRub, parseDecimalToMinor } from '../../domain/money.js';
import { RATE_SCALE, formatRate, parseRate } from '../../domain/pricing.js';
import { previewSettlement, type Attached, type OrderWithClient } from '../../services/order-service.js';
import { RateUnavailableError } from '../../services/rates.js';
import { o as ot } from '../../texts/orders.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

// ── Отклонение ───────────────────────────────────────────────────────────
interface RejectData {
  orderId: number;
  version: number;
  adminId: number;
  reason?: string;
}

export async function startReject(ctx: BotContext, deps: Deps, order: OrderWithClient): Promise<void> {
  await deps.wizards.start(ctx, rejectWizard(deps), {
    orderId: order.id,
    version: order.version,
    adminId: ctx.appUser!.id,
  } satisfies RejectData);
}

function rejectWizard(deps: Deps): WizardDef<RejectData> {
  return {
    name: 'reject',
    steps: [
      {
        key: 'reason',
        prompt: () => ({ text: ot.rejectReasonPrompt }),
        handle: async (input, d, ctx) => {
          const r = await freeText(input, ctx, 2, 300, { checkSecrets: false });
          if (!r.ok) return r.error;
          d.reason = r.value;
          return undefined;
        },
      },
    ],
    finish: async (ctx, d) => {
      try {
        const order = await deps.orders.reject(d.orderId, d.version, d.adminId, d.reason!);
        const view = await deps.presenter.admin(order);
        await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
        const kept = order.paidAt ? `\n${ot.balanceKept}` : '';
        await deps.notifier.toClient(order.client.telegramId, ot.rejectedNotice(order.id, d.reason!) + kept);
      } catch (e) {
        if (!(await handleOrderError(ctx, deps, e, d.orderId))) throw e;
      }
    },
  };
}

// ── Выполнено ────────────────────────────────────────────────────────────
interface DoneData {
  orderId: number;
  version: number;
  adminId: number;
  isGift: boolean;
  cards: AdminCard[];
  giftCode?: string;
  card?: AdminCard;
  actualMinor?: bigint;
  rateScaled?: bigint;
  screenshot?: Attached;
}

export async function startDone(ctx: BotContext, deps: Deps, order: OrderWithClient): Promise<void> {
  const cards = await deps.catalog.listCards(true);
  if (cards.length === 0) return void (await ctx.reply(ot.noCards));
  await deps.wizards.start(ctx, doneWizard(deps), {
    orderId: order.id,
    version: order.version,
    adminId: ctx.appUser!.id,
    isGift: order.type === 'GIFT_CARD',
    cards,
  } satisfies DoneData);
}

function doneWizard(deps: Deps): WizardDef<DoneData> {
  return {
    name: 'done',
    steps: [
      {
        key: 'code',
        skip: (d) => !d.isGift,
        prompt: () => ({ text: ot.giftCodePrompt }),
        handle: async (input, d, ctx) => {
          const r = await freeText(input, ctx, 3, 500, { checkSecrets: false });
          if (!r.ok) return r.error;
          d.giftCode = r.value;
          await tryDelete(ctx); // код не оставляем в истории чата админа
          return undefined;
        },
      },
      {
        key: 'card',
        prompt: (d) => ({
          text: ot.cardPrompt,
          buttons: d.cards.map((c) => [{ label: `${c.label} (${c.currency})`, value: String(c.id) }]),
        }),
        handle: async (input, d) => {
          const card = d.cards.find((c) => String(c.id) === input.button);
          if (!card) return ot.useButtons;
          d.card = card;
          if (card.currency === 'RUB') d.rateScaled = RATE_SCALE;
          return undefined;
        },
      },
      {
        key: 'actual',
        prompt: (d) => ({ text: ot.actualPrompt(d.card!.currency) }),
        handle: async (input, d) => {
          try {
            const minor = parseDecimalToMinor(input.text ?? '');
            if (minor <= 0n || minor > 10_000_000_000n) return ot.amountLimit;
            d.actualMinor = minor;
            return undefined;
          } catch (e) {
            if (e instanceof MoneyParseError) return ot.badAmount;
            throw e;
          }
        },
      },
      {
        key: 'rate',
        skip: (d) => d.card?.currency === 'RUB',
        prompt: async (d) => {
          const cur = d.card!.currency;
          try {
            const r = await deps.rates.getRate(cur);
            return {
              text: ot.ratePrompt(cur, formatRate(r.scaled), r.source === 'MANUAL' ? 'ручной' : 'ЦБ'),
              buttons: [[{ label: ot.acceptRate, value: 'ok' }]],
            };
          } catch (e) {
            if (e instanceof RateUnavailableError) return { text: ot.rateUnavailable(cur) };
            throw e;
          }
        },
        handle: async (input, d) => {
          if (input.button === 'ok') {
            try {
              d.rateScaled = (await deps.rates.getRate(d.card!.currency)).scaled;
              return undefined;
            } catch (e) {
              if (e instanceof RateUnavailableError) return ot.rateUnavailable(d.card!.currency);
              throw e;
            }
          }
          try {
            d.rateScaled = parseRate(input.text ?? '');
            return undefined;
          } catch {
            return ot.badRate;
          }
        },
      },
      {
        key: 'shot',
        prompt: () => ({ text: ot.screenshotPrompt, buttons: [[{ label: ot.skipBtn, value: 'skip' }]] }),
        handle: async (input, d) => {
          if (input.button === 'skip') return undefined;
          if (!input.file) return ot.needFile;
          d.screenshot = { fileId: input.file.id, fileType: input.file.type, uniqueId: input.file.uniqueId };
          return undefined;
        },
      },
      {
        key: 'confirm',
        prompt: async (d) => {
          const order = await deps.orders.getOrThrow(d.orderId);
          const s = previewSettlement(order, d.actualMinor!, d.rateScaled!);
          return {
            text: ot.doneSummary({
              card: `${d.card!.label} (${d.card!.currency})`,
              actual: `${formatMinor(d.actualMinor!)} ${d.card!.currency}`,
              actualRub: formatRub(s.actualRubMinor),
              base: formatRub(s.baseCostMinor),
              diff: formatRub(s.diffMinor),
              diffKind: s.diffMinor > 0n ? ot.diffOver : s.diffMinor < 0n ? ot.diffUnder : ot.diffZero,
            }),
            buttons: [[{ label: ot.confirmBtn, value: 'ok' }]],
          };
        },
        handle: async (input) => (input.button === 'ok' ? undefined : ot.useButtons),
      },
    ],
    finish: async (ctx, d) => {
      try {
        const { order, settlement } = await deps.orders.complete(d.orderId, d.version, d.adminId, {
          cardId: d.card!.id,
          actualChargeMinor: d.actualMinor!,
          cardRateScaled: d.rateScaled!,
          ...(d.giftCode ? { giftCode: d.giftCode } : {}),
          ...(d.screenshot ? { screenshot: d.screenshot } : {}),
        });
        deps.log.info({ orderId: order.id }, 'order done');
        const view = await deps.presenter.admin(order);
        await ctx.reply(`${ot.doneByAdmin(order.id)}\n\n${view.text}`, { ...html, reply_markup: view.keyboard });

        await notifyOrderDone(deps, order, settlement, d.giftCode);
      } catch (e) {
        if (!(await handleOrderError(ctx, deps, e, d.orderId))) throw e;
      }
    },
  };
}
