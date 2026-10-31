import { describe, expect, it } from 'vitest';
import {
  MoneyParseError,
  TAIL_MAX,
  TAIL_MIN,
  creditKopecks,
  formatUsdt,
  parseUsdtInput,
  pickInvoiceAmount,
} from '../src/domain/crypto-invoice.js';
import { isValidTronAddress } from '../src/domain/tron-address.js';

describe('isValidTronAddress', () => {
  it('accepts real addresses (checksum verified)', () => {
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true); // контракт USDT
  });
  it('rejects typos, wrong alphabet, wrong length and other chains', () => {
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toBe(false); // одна буква изменена
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6')).toBe(false); // короче
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6tt')).toBe(false); // длиннее
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj0t')).toBe(false); // «0» нет в base58
    expect(isValidTronAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(false); // Ethereum
    expect(isValidTronAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(false); // Bitcoin
    expect(isValidTronAddress('')).toBe(false);
  });
});

describe('USDT amounts', () => {
  it('parses client input (up to 2 decimals)', () => {
    expect(parseUsdtInput('50')).toBe(50_000_000n);
    expect(parseUsdtInput('50,5')).toBe(50_500_000n);
    expect(parseUsdtInput('0.25 USDT')).toBe(250_000n);
    expect(() => parseUsdtInput('1.234')).toThrow(MoneyParseError);
    expect(() => parseUsdtInput('abc')).toThrow(MoneyParseError);
  });
  it('formats with a fixed number of decimals', () => {
    expect(formatUsdt(50_013_700n)).toBe('50.0137');
    expect(formatUsdt(50_000_000n)).toBe('50.0000');
    expect(formatUsdt(123n, 6)).toBe('0.000123');
  });
  it('credit = amount × rate × (1 − fee), rounded down, in kopecks', () => {
    const rate92 = 9_200_000_000n;
    expect(creditKopecks(50_000_000n, rate92, 100)).toBe(455_400n); // 50 × 92 × 0,99 = 4 554 ₽
    expect(creditKopecks(50_000_000n, rate92, 0)).toBe(460_000n);
    expect(creditKopecks(1n, rate92, 0)).toBe(0n); // пыль — ноль, а не округление вверх
    expect(creditKopecks(33_333_333n, rate92, 100)).toBe((33_333_333n * rate92 * 9900n) / 1_000_000_000_000n / 10_000n);
    expect(() => creditKopecks(0n, rate92, 0)).toThrow(RangeError);
    expect(() => creditKopecks(1n, rate92, 6000)).toThrow(RangeError);
  });
});

describe('pickInvoiceAmount', () => {
  it('adds a tail within [0.0001, 0.0099] and never reuses a taken amount', () => {
    const base = 50_000_000n;
    const a = pickInvoiceAmount(base, new Set(), () => 0);
    expect(a).toBe(base + TAIL_MIN);
    const b = pickInvoiceAmount(base, new Set([a]), () => 0);
    expect(b).toBe(base + TAIL_MIN + 1n);
    for (let i = 0; i < 50; i++) {
      const x = pickInvoiceAmount(base, new Set(), Math.random);
      expect(x - base).toBeGreaterThanOrEqual(TAIL_MIN);
      expect(x - base).toBeLessThanOrEqual(TAIL_MAX);
    }
  });
  it('wraps around and fails only when every tail is taken', () => {
    const base = 10_000_000n;
    const taken = new Set<bigint>();
    for (let t = TAIL_MIN; t <= TAIL_MAX; t++) taken.add(base + t);
    expect(() => pickInvoiceAmount(base, taken)).toThrow(RangeError);
    taken.delete(base + TAIL_MIN + 5n);
    expect(pickInvoiceAmount(base, taken, () => 0.9)).toBe(base + TAIL_MIN + 5n);
  });
});
