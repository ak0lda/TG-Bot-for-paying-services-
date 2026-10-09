import type { OrderType, PayMode, PeriodKind } from '@prisma/client';
import type { Deps } from '../context.js';
import type { Step, WizardDef } from './engine.js';
import { freeText, linkInput } from './helpers.js';
import { MoneyParseError, parseDecimalToMinor, formatMinor, formatRub } from '../../domain/money.js';
import { availableOf, payLaterExposure } from '../../domain/ledger.js';
import { balanceOf } from '../../services/ledger-service.js';
import { RateUnavailableError } from '../../services/rates.js';
import { TYPE_LABEL, o as ot, periodLabel, LINK_REMINDER } from '../../texts/orders.js';
import { escapeHtml } from '../../texts/ru.js';

export interface OrderDraft {
  clientId: number;
  type?: OrderType;
  url?: string;
  urlDomain?: string;
  urlTrusted?: boolean;
  service?: string;
  region?: string;
  description?: string;
  amountMinor?: bigint;
  currency?: string;
  periodChoice?: 'ONE' | PeriodKind;
  periodDays?: number;
  comment?: string | null;
  payMode?: PayMode;
}

const TYPES: OrderType[] = ['PAYMENT_LINK', 'GIFT_CARD', 'TOP_UP', 'OTHER'];
const MAX_AMOUNT_MINOR = 100_000_000n; // 1 000 000.00

export function orderWizard(deps: Deps): WizardDef<OrderDraft> {
  /** Проверка, что курс по валюте есть (ЦБ или ручной). */
  async function checkCurrency(raw: string): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return { ok: false, error: ot.badCurrency };
    if (code === 'RUB') return { ok: false, error: ot.rubCurrency };
    try {
      await deps.rates.getRate(code);
    } catch (e) {
      if (e instanceof RateUnavailableError) return { ok: false, error: ot.noRate(code) };
      throw e;
    }
    return { ok: true, code };
  }

  /** Доступные клиенту режимы оплаты (PREPAY — всегда). */
  async function availableModes(clientId: number): Promise<Array<{ mode: PayMode; label: string }>> {
    const user = await deps.db.user.findUniqueOrThrow({ where: { id: clientId } });
    const balance = await balanceOf(deps.db, clientId);
    const modes: Array<{ mode: PayMode; label: string }> = [{ mode: 'PREPAY', label: ot.payModeLabel.PREPAY }];
    if (availableOf(balance) > 0n) modes.push({ mode: 'BALANCE', label: ot.payModeLabel.BALANCE(formatRub(availableOf(balance))) });
    if (user.payLaterEnabled && user.payLaterLimitMinor > 0n) {
      const open = await deps.db.order.aggregate({
        where: { clientId, payMode: 'PAY_LATER', status: { in: ['IN_PROGRESS', 'LINK_INVALID'] } },
        _sum: { totalMinor: true },
      });
      const used = payLaterExposure(balance, open._sum.totalMinor ?? 0n, 0n);
      if (used < user.payLaterLimitMinor) {
        modes.push({ mode: 'PAY_LATER', label: ot.payModeLabel.PAY_LATER(formatRub(user.payLaterLimitMinor - used)) });
      }
    }
    return modes;
  }

  const steps: Step<OrderDraft>[] = [
    {
      key: 'type',
      prompt: () => ({
        text: ot.stepType,
        buttons: TYPES.map((t) => [{ label: TYPE_LABEL[t], value: t }]),
      }),
      handle: async (input, d) => {
        if (!input.button || !TYPES.includes(input.button as OrderType)) return ot.useButtons;
        d.type = input.button as OrderType;
        return undefined;
      },
    },
    {
      key: 'url',
      skip: (d) => d.type === 'GIFT_CARD',
      prompt: (d) => ({
        text: ot.stepUrl(d.type === 'OTHER'),
        buttons: d.type === 'OTHER' ? [[{ label: ot.skipBtn, value: 'skip' }]] : [],
      }),
      handle: async (input, d) => {
        if (input.button === 'skip' && d.type === 'OTHER') return undefined;
        const res = await linkInput(input, deps);
        if (!res.ok) return res.error;
        d.url = res.value.url;
        d.urlDomain = res.value.domain;
        d.urlTrusted = res.value.trusted;
        return undefined;
      },
    },
    {
      key: 'service',
      prompt: (d) => ({ text: d.type === 'GIFT_CARD' ? ot.stepServiceGift : ot.stepService }),
      handle: async (input, d, ctx) => {
        const r = await freeText(input, ctx, 2, 80);
        if (!r.ok) return r.error;
        d.service = r.value;
        return undefined;
      },
    },
    {
      key: 'region',
      skip: (d) => d.type !== 'GIFT_CARD',
      prompt: () => ({ text: ot.stepRegion }),
      handle: async (input, d, ctx) => {
        const r = await freeText(input, ctx, 2, 40);
        if (!r.ok) return r.error;
        d.region = r.value;
        return undefined;
      },
    },
    {
      key: 'description',
      skip: (d) => d.type === 'GIFT_CARD',
      prompt: (d) => ({ text: ot.stepDescription(d.type!) }),
      handle: async (input, d, ctx) => {
        const r = await freeText(input, ctx, 2, 500);
        if (!r.ok) return r.error;
        d.description = r.value;
        return undefined;
      },
    },
    {
      key: 'amount',
      prompt: (d) => ({ text: ot.stepAmount(d.type === 'GIFT_CARD') }),
      handle: async (input, d) => {
        const m = /^\s*([\d\s]+(?:[.,]\d{1,2})?)\s*([A-Za-z]{3})?\s*$/.exec(input.text ?? '');
        if (!m) return ot.badAmount;
        let minor: bigint;
        try {
          minor = parseDecimalToMinor(m[1]!);
        } catch (e) {
          if (e instanceof MoneyParseError) return ot.badAmount;
          throw e;
        }
        if (minor <= 0n || minor > MAX_AMOUNT_MINOR) return ot.amountLimit;
        if (m[2]) {
          const cur = await checkCurrency(m[2]);
          if (!cur.ok) return cur.error;
          d.currency = cur.code;
        }
        d.amountMinor = minor;
        return undefined;
      },
    },
    {
      key: 'currency',
      skip: (d) => d.currency !== undefined,
      prompt: () => ({
        text: ot.stepCurrency,
        buttons: [[{ label: 'USD', value: 'USD' }, { label: 'EUR', value: 'EUR' }, { label: 'GBP', value: 'GBP' }]],
      }),
      handle: async (input, d) => {
        const cur = await checkCurrency(input.button ?? input.text ?? '');
        if (!cur.ok) return cur.error;
        d.currency = cur.code;
        return undefined;
      },
    },
    {
      key: 'period',
      skip: (d) => d.type === 'GIFT_CARD' || d.type === 'TOP_UP',
      prompt: () => ({
        text: ot.stepPeriod,
        buttons: [
          [{ label: 'Разовая оплата', value: 'ONE' }],
          [{ label: 'Подписка — месяц', value: 'MONTH' }],
          [{ label: 'Подписка — год', value: 'YEAR' }],
          [{ label: 'Подписка — свой период', value: 'CUSTOM' }],
        ],
      }),
      handle: async (input, d) => {
        if (!['ONE', 'MONTH', 'YEAR', 'CUSTOM'].includes(input.button ?? '')) return ot.useButtons;
        d.periodChoice = input.button as OrderDraft['periodChoice'];
        return undefined;
      },
    },
    {
      key: 'days',
      skip: (d) => d.periodChoice !== 'CUSTOM',
      prompt: () => ({ text: ot.stepPeriodDays }),
      handle: async (input, d) => {
        const t = input.text?.trim() ?? '';
        if (!/^\d{1,3}$/.test(t) || Number(t) < 1 || Number(t) > 730) return ot.badDays;
        d.periodDays = Number(t);
        return undefined;
      },
    },
    {
      key: 'comment',
      prompt: () => ({ text: ot.stepComment, buttons: [[{ label: ot.skipBtn, value: 'skip' }]] }),
      handle: async (input, d, ctx) => {
        if (input.button === 'skip') {
          d.comment = null;
          return undefined;
        }
        const r = await freeText(input, ctx, 1, 500);
        if (!r.ok) return r.error;
        d.comment = r.value;
        return undefined;
      },
    },
    {
      key: 'paymode',
      // Если доступен только перевод — шаг пропускается (режим PREPAY).
      skip: async (d) => {
        if ((await availableModes(d.clientId)).length > 1) return false;
        d.payMode = 'PREPAY';
        return true;
      },
      prompt: async (d) => ({
        text: ot.stepPayMode,
        buttons: (await availableModes(d.clientId)).map((m) => [{ label: m.label, value: m.mode }]),
      }),
      handle: async (input, d) => {
        const modes = await availableModes(d.clientId);
        const chosen = modes.find((m) => m.mode === input.button);
        if (!chosen) return input.button ? ot.payModeUnavailable : ot.useButtons;
        d.payMode = chosen.mode;
        return undefined;
      },
    },
    {
      key: 'confirm',
      prompt: (d) => ({ text: summary(d), buttons: [[{ label: ot.sendBtn, value: 'send' }]] }),
      handle: async (input) => (input.button === 'send' ? undefined : ot.useButtons),
    },
  ];

  return {
    name: 'order',
    steps,
    finish: async (ctx, d) => {
      const isSub = d.periodChoice !== undefined && d.periodChoice !== 'ONE';
      const order = await deps.orders.create({
        clientId: d.clientId,
        type: d.type!,
        service: d.service!,
        description: d.description ?? null,
        url: d.url ?? null,
        urlDomain: d.urlDomain ?? null,
        giftRegion: d.region ?? null,
        amountMinor: d.amountMinor!,
        currency: d.currency!,
        isSubscription: isSub,
        periodKind: isSub ? (d.periodChoice as PeriodKind) : null,
        periodDays: isSub ? (d.periodDays ?? null) : null,
        comment: d.comment ?? null,
        payMode: d.payMode ?? 'PREPAY',
      });
      deps.log.info({ orderId: order.id, type: order.type }, 'order created');
      const extra = d.url && d.urlTrusted === false ? `\n${ot.untrustedNote}` : '';
      await ctx.reply(`${ot.orderCreated(order.id)}${extra}\n\n${LINK_REMINDER}`, { parse_mode: 'HTML' });
      await deps.presenter.notifyAdmin(order, ot.adminNewOrder);
    },
  };
}

function summary(d: OrderDraft): string {
  const lines = [`<b>${ot.summaryTitle}</b>`, `Тип: ${TYPE_LABEL[d.type!]}`, `Сервис: ${escapeHtml(d.service ?? '')}`];
  if (d.region) lines.push(`Регион: ${escapeHtml(d.region)}`);
  if (d.description) lines.push(`Описание: ${escapeHtml(d.description)}`);
  if (d.urlTrusted === false) lines.push(`Домен: ${escapeHtml(d.urlDomain ?? '')} ⚠️`);
  else if (d.urlDomain) lines.push(`Домен: ${escapeHtml(d.urlDomain)} ✅`);
  lines.push(`Сумма: ${formatMinor(d.amountMinor ?? 0n)} ${d.currency ?? ''}`);
  if (d.type !== 'GIFT_CARD' && d.type !== 'TOP_UP') {
    lines.push(
      d.periodChoice && d.periodChoice !== 'ONE'
        ? `Подписка: ${periodLabel(d.periodChoice, d.periodDays ?? null)}`
        : 'Разовая оплата',
    );
  }
  if (d.comment) lines.push(`Комментарий: ${escapeHtml(d.comment)}`);
  lines.push(`Оплата: ${ot.payModeShort[d.payMode ?? 'PREPAY']}`);
  return lines.join('\n');
}
