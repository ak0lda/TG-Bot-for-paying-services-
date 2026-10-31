import type { OrderType, PeriodKind } from '@prisma/client';
import { MoneyParseError, parseDecimalToMinor } from './money.js';

export interface PresetInput {
  name: string;
  type: OrderType;
  currency: string | null;
  amountMinor: bigint | null;
  periodKind: PeriodKind | null;
  periodDays: number | null;
}

const TYPES: OrderType[] = ['PAYMENT_LINK', 'GIFT_CARD', 'TOP_UP', 'OTHER'];
const empty = (s: string | undefined) => s === undefined || s === '' || s === '-';

/**
 * «Netflix | PAYMENT_LINK | USD | 15,99 | MONTH» — всё, кроме названия, необязательно (`-` = не задано).
 * Период: ONE (разовая) | MONTH | YEAR | CUSTOM:30 (дней).
 */
export function parsePreset(raw: string): PresetInput | { error: string } {
  const [nameRaw = '', typeRaw, curRaw, amountRaw, periodRaw] = raw.split('|').map((s) => s.trim());
  if (nameRaw.length < 2 || nameRaw.length > 40) return { error: 'Название сервиса: 2–40 символов.' };

  const type = empty(typeRaw) ? 'PAYMENT_LINK' : (typeRaw!.toUpperCase() as OrderType);
  if (!TYPES.includes(type)) return { error: `Тип: ${TYPES.join(' | ')}.` };

  let currency: string | null = null;
  if (!empty(curRaw)) {
    currency = curRaw!.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || currency === 'RUB')
      return { error: 'Валюта: трёхбуквенный код, не RUB (например USD).' };
  }

  let amountMinor: bigint | null = null;
  if (!empty(amountRaw)) {
    try {
      amountMinor = parseDecimalToMinor(amountRaw!);
    } catch (e) {
      if (e instanceof MoneyParseError) return { error: 'Сумма: число, например 15,99.' };
      throw e;
    }
    if (amountMinor <= 0n || amountMinor > 100_000_000n) return { error: 'Сумма вне допустимого диапазона.' };
    if (!currency) return { error: 'Сумму нужно указывать вместе с валютой.' };
  }

  let periodKind: PeriodKind | null = null;
  let periodDays: number | null = null;
  if (!empty(periodRaw)) {
    const p = periodRaw!.toUpperCase();
    const custom = /^CUSTOM:(\d{1,3})$/.exec(p);
    if (p === 'MONTH' || p === 'YEAR') periodKind = p;
    else if (custom && Number(custom[1]) >= 1 && Number(custom[1]) <= 730) {
      periodKind = 'CUSTOM';
      periodDays = Number(custom[1]);
    } else if (p !== 'ONE') return { error: 'Период: ONE | MONTH | YEAR | CUSTOM:30.' };
  }
  return { name: nameRaw, type, currency, amountMinor, periodKind, periodDays };
}
