import { z } from 'zod';
import type { PayMode, PeriodKind } from '@prisma/client';
import type { Deps } from '../../bot/context.js';
import { availableModes } from '../../bot/wizard/pay-modes.js';
import { validateLink } from '../../domain/link-validator.js';
import { MoneyParseError, parseDecimalToMinor } from '../../domain/money.js';
import { detectSecret } from '../../domain/secret-detector.js';
import type { NewOrderInput } from '../../services/order-service.js';
import { RateUnavailableError } from '../../services/rates.js';
import { o as ot } from '../../texts/orders.js';
import { ApiError } from './errors.js';

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const newOrderSchema = z.object({
  type: z.enum(['PAYMENT_LINK', 'GIFT_CARD', 'TOP_UP', 'OTHER']),
  url: z.string().trim().max(2048).optional(),
  service: text(2, 80),
  region: text(2, 40).optional(),
  description: text(2, 500).optional(),
  amount: z.string().trim().min(1).max(20),
  currency: z.string().trim().length(3),
  period: z.enum(['ONE', 'MONTH', 'YEAR', 'CUSTOM']).default('ONE'),
  periodDays: z.number().int().min(1).max(730).optional(),
  comment: text(1, 500).optional(),
  payMode: z.enum(['PREPAY', 'BALANCE', 'PAY_LATER']).default('PREPAY'),
});

const MAX_AMOUNT_MINOR = 100_000_000n;

const fail = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new ApiError(422, code, message, extra);

/** Те же правила, что в диалоге бота: ссылки, секреты, валюта/курс, режим оплаты, обязательные поля по типам. */
export async function toNewOrderInput(
  deps: Deps,
  clientId: number,
  body: unknown,
): Promise<{ input: NewOrderInput; untrusted: boolean }> {
  const b = newOrderSchema.parse(body);

  for (const [field, value] of Object.entries({
    service: b.service,
    region: b.region,
    description: b.description,
    comment: b.comment,
  })) {
    if (value && detectSecret(value)) throw fail('secret_detected', ot.secretWarning, { field });
  }

  const needsUrl = b.type === 'PAYMENT_LINK' || b.type === 'TOP_UP';
  const allowsUrl = b.type !== 'GIFT_CARD';
  const needsDescription = b.type !== 'GIFT_CARD';
  if (b.type === 'GIFT_CARD' && !b.region)
    throw fail('region_required', 'Укажи регион подарочной карты', { field: 'region' });
  if (needsDescription && !b.description)
    throw fail('description_required', 'Нужно описание', { field: 'description' });

  let url: string | null = null;
  let urlDomain: string | null = null;
  let untrusted = false;
  if (allowsUrl && b.url) {
    const res = validateLink(b.url, await deps.domains.list());
    if (!res.ok) throw fail(`link_${res.error}`, ot.link[res.error], { field: 'url' });
    url = res.url;
    urlDomain = res.domain;
    untrusted = !res.trusted;
  } else if (needsUrl) {
    throw fail('url_required', 'Нужна ссылка на оплату', { field: 'url' });
  }

  let amountMinor: bigint;
  try {
    amountMinor = parseDecimalToMinor(b.amount);
  } catch (e) {
    if (e instanceof MoneyParseError) throw fail('bad_amount', ot.badAmount, { field: 'amount' });
    throw e;
  }
  if (amountMinor <= 0n || amountMinor > MAX_AMOUNT_MINOR)
    throw fail('amount_limit', ot.amountLimit, { field: 'amount' });

  const currency = b.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw fail('bad_currency', ot.badCurrency, { field: 'currency' });
  if (currency === 'RUB') throw fail('rub_currency', ot.rubCurrency, { field: 'currency' });
  try {
    await deps.rates.getRate(currency);
  } catch (e) {
    if (e instanceof RateUnavailableError)
      throw fail('rate_unavailable', ot.noRate(currency).replace(/<[^>]+>/g, ''), { field: 'currency' });
    throw e;
  }

  const subscribable = b.type === 'PAYMENT_LINK' || b.type === 'OTHER';
  const isSubscription = subscribable && b.period !== 'ONE';
  if (isSubscription && b.period === 'CUSTOM' && !b.periodDays)
    throw fail('days_required', ot.badDays, { field: 'periodDays' });

  const modes = await availableModes(deps, clientId);
  if (!modes.some((x) => x.mode === b.payMode))
    throw fail('pay_mode_unavailable', ot.payModeUnavailable, { field: 'payMode' });

  return {
    untrusted,
    input: {
      clientId,
      type: b.type,
      service: b.service,
      description: b.type === 'GIFT_CARD' ? null : (b.description ?? null),
      url,
      urlDomain,
      giftRegion: b.type === 'GIFT_CARD' ? (b.region ?? null) : null,
      amountMinor,
      currency,
      isSubscription,
      periodKind: isSubscription ? (b.period as PeriodKind) : null,
      periodDays: isSubscription && b.period === 'CUSTOM' ? (b.periodDays ?? null) : null,
      comment: b.comment ?? null,
      payMode: b.payMode as PayMode,
    },
  };
}
