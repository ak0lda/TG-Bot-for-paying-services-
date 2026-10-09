import { ceilToWholeRubles } from './money.js';

/** Курс хранится целым числом с 8 знаками: 92,1234 ₽ → 9_212_340_000n. */
export const RATE_DECIMALS = 8;
export const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);
const BP = 10_000n;

// Все суммы иностранной валюты хранятся в сотых долях (exponent 2), рубли — в копейках.

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface QuoteInput {
  amountMinor: bigint;
  rateScaled: bigint;
  fxBufferBp: number;
  markupBp: number;
  fixedFeeMinor: bigint;
}

export interface Quote {
  /** Оценка себестоимости: сумма × курс × (1 + запас). Нужна для расчёта разницы по факту. */
  baseCostMinor: bigint;
  /** Итог для клиента, целые рубли (в копейках, кратно 100). */
  totalMinor: bigint;
}

function assertInput(i: QuoteInput): void {
  if (i.amountMinor <= 0n) throw new RangeError('amount must be positive');
  if (i.rateScaled <= 0n) throw new RangeError('rate must be positive');
  if (!Number.isInteger(i.fxBufferBp) || i.fxBufferBp < 0) throw new RangeError('bad fx buffer');
  if (!Number.isInteger(i.markupBp) || i.markupBp < 0) throw new RangeError('bad markup');
  if (i.fixedFeeMinor < 0n) throw new RangeError('bad fixed fee');
}

/** Итог = сумма × курс × (1 + запас) × (1 + наценка) + фикс, округление вверх до целых рублей. */
export function computeQuote(i: QuoteInput): Quote {
  assertInput(i);
  const fx = BP + BigInt(i.fxBufferBp);
  const mk = BP + BigInt(i.markupBp);
  const rawTotal = ceilDiv(i.amountMinor * i.rateScaled * fx * mk, RATE_SCALE * BP * BP);
  return {
    baseCostMinor: ceilDiv(i.amountMinor * i.rateScaled * fx, RATE_SCALE * BP),
    totalMinor: ceilToWholeRubles(rawTotal + i.fixedFeeMinor),
  };
}

/** Перевод суммы в рубли по курсу, округление до копейки «half up». */
export function convertToRubMinor(amountMinor: bigint, rateScaled: bigint): bigint {
  return (amountMinor * rateScaled + RATE_SCALE / 2n) / RATE_SCALE;
}

/**
 * Разница по факту: оценка себестоимости минус реальное списание в рублях.
 * > 0 — переплата клиента (зачисляем на баланс), < 0 — доплата (списываем с баланса).
 * Наценка и фиксированная комиссия в разницу не входят — это доход админа.
 */
export function settlementDiff(baseCostMinor: bigint, actualRubMinor: bigint): bigint {
  return baseCostMinor - actualRubMinor;
}

export function parseRate(input: string): bigint {
  const normalized = input.trim().replace(/\s+/g, '').replace(',', '.');
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(normalized);
  if (!m) throw new RangeError('bad rate');
  const scaled = BigInt((m[1] ?? '0') + (m[2] ?? '').padEnd(RATE_DECIMALS, '0'));
  if (scaled <= 0n) throw new RangeError('bad rate');
  return scaled;
}

export function formatRate(scaled: bigint, minDecimals = 2): string {
  const whole = scaled / RATE_SCALE;
  let frac = (scaled % RATE_SCALE).toString().padStart(RATE_DECIMALS, '0');
  while (frac.length > minDecimals && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${whole},${frac}`;
}

/** Для хранения в Decimal(18,8): "92.12340000". */
export function rateToDecimalString(scaled: bigint): string {
  return `${scaled / RATE_SCALE}.${(scaled % RATE_SCALE).toString().padStart(RATE_DECIMALS, '0')}`;
}

export function rateFromDecimalString(s: string): bigint {
  const [whole = '0', frac = ''] = s.split('.');
  return BigInt(whole + frac.padEnd(RATE_DECIMALS, '0').slice(0, RATE_DECIMALS));
}
