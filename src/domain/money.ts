// Деньги — только BigInt в минимальных единицах. Никаких float.

export class MoneyParseError extends Error {}

/** "12,5" | "12.50" | "1 200" -> минимальные единицы (по умолчанию 2 знака). */
export function parseDecimalToMinor(input: string, exponent = 2): bigint {
  const normalized = input.trim().replace(/\s+/g, '').replace(',', '.');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new MoneyParseError('not a number');
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > exponent) throw new MoneyParseError('too many decimal places');
  return BigInt(whole + fraction.padEnd(exponent, '0'));
}

export function formatMinor(minor: bigint, exponent = 2): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const base = 10n ** BigInt(exponent);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const fraction = (abs % base).toString().padStart(exponent, '0');
  const body = exponent > 0 && fraction !== '0'.repeat(exponent) ? `${whole},${fraction}` : whole;
  return negative ? `−${body}` : body;
}

export function formatRub(minor: bigint): string {
  return `${formatMinor(minor)} ₽`;
}

/** Округление копеек вверх до целых рублей. */
export function ceilToWholeRubles(kopecks: bigint): bigint {
  const rem = kopecks % 100n;
  return rem === 0n ? kopecks : kopecks + (100n - rem);
}
