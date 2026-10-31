import { MoneyParseError, parseDecimalToMinor } from './money.js';

/** USDT имеет 6 знаков: «micro» = 1e-6 USDT. */
export const USDT_DECIMALS = 6;
const MICRO = 10n ** BigInt(USDT_DECIMALS);

/** Ввод клиента «50», «50,5», «50.25» (до 2 знаков) -> micro. */
export function parseUsdtInput(input: string): bigint {
  const hundredths = parseDecimalToMinor(input.replace(/usdt/i, '').trim(), 2); // кидает MoneyParseError
  return hundredths * (MICRO / 100n);
}

/** «50.0137» — всегда 4 знака: «хвост» суммы это 4-я цифра после запятой и дальше. */
export function formatUsdt(micro: bigint, decimals = 4): string {
  const scale = 10n ** BigInt(USDT_DECIMALS - decimals);
  const v = micro / scale;
  const base = 10n ** BigInt(decimals);
  return `${v / base}.${(v % base).toString().padStart(decimals, '0')}`;
}

/**
 * Сколько копеек зачислить: сумма USDT × курс (₽ за 1 USDT, масштаб 1e8) × (1 − комиссия), округление вниз.
 * micro × rateScaled / 1e12 = копейки (1e-6 × 1e-8 × 100 = 1e-12).
 */
export function creditKopecks(amountMicro: bigint, rateScaled: bigint, feeBp: number): bigint {
  if (amountMicro <= 0n || rateScaled <= 0n) throw new RangeError('amount and rate must be positive');
  if (!Number.isInteger(feeBp) || feeBp < 0 || feeBp > 5000) throw new RangeError('bad fee');
  return (amountMicro * rateScaled * BigInt(10_000 - feeBp)) / (1_000_000_000_000n * 10_000n);
}

export const TAIL_MIN = 100n; // 0.0001 USDT
export const TAIL_MAX = 9999n; // 0.0099... — не больше ~1 цента

/**
 * Уникальная сумма счёта: запрошенная + «хвост» 0.0001–0.0099 USDT, не совпадающая ни с одним открытым счётом.
 * По точной сумме бот находит, чей это перевод (адрес у всех один). Клиент переплачивает не больше цента.
 */
export function pickInvoiceAmount(
  requestedMicro: bigint,
  taken: ReadonlySet<bigint>,
  random: () => number = Math.random,
): bigint {
  const span = Number(TAIL_MAX - TAIL_MIN + 1n);
  const start = Math.floor(random() * span);
  for (let i = 0; i < span; i++) {
    const tail = TAIL_MIN + BigInt((start + i) % span);
    if (!taken.has(requestedMicro + tail)) return requestedMicro + tail;
  }
  throw new RangeError('no free invoice amount');
}

export { MoneyParseError };
