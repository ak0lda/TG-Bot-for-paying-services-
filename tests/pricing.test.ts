import { describe, expect, it } from 'vitest';
import {
  computeQuote,
  convertToRubMinor,
  formatRate,
  parseRate,
  rateFromDecimalString,
  rateToDecimalString,
  settlementDiff,
} from '../src/domain/pricing.js';

const base = { amountMinor: 1000n, rateScaled: parseRate('90'), fxBufferBp: 0, markupBp: 0, fixedFeeMinor: 0n };

describe('computeQuote', () => {
  it('plain conversion', () => {
    // 10.00 USD × 90 = 900 ₽
    expect(computeQuote(base).totalMinor).toBe(90_000n);
  });

  it('applies fx buffer and markup multiplicatively + fixed fee, rounds up to whole rubles', () => {
    // 10 × 90 × 1.02 × 1.05 = 963.90 → +50 = 1013.90 → 1014 ₽
    const q = computeQuote({ ...base, fxBufferBp: 200, markupBp: 500, fixedFeeMinor: 5_000n });
    expect(q.totalMinor).toBe(101_400n);
    expect(q.baseCostMinor).toBe(91_800n); // 10 × 90 × 1.02 = 918.00
  });

  it('rounds up even by a fraction of a kopeck', () => {
    // 0.01 USD × 90.0001 = 0.900001 ₽ → 1 ₽
    expect(computeQuote({ ...base, amountMinor: 1n, rateScaled: parseRate('90.0001') }).totalMinor).toBe(100n);
  });

  it('is exact on large values (no float drift)', () => {
    const q = computeQuote({ ...base, amountMinor: 9_999_999_99n, rateScaled: parseRate('99.99999999') });
    expect(q.totalMinor % 100n).toBe(0n);
    expect(q.totalMinor).toBeGreaterThanOrEqual(99_999_999_000n);
  });

  it('allows all parameters to be zero', () => {
    expect(computeQuote(base).baseCostMinor).toBe(90_000n);
  });

  it('rejects invalid input', () => {
    expect(() => computeQuote({ ...base, amountMinor: 0n })).toThrow(RangeError);
    expect(() => computeQuote({ ...base, rateScaled: 0n })).toThrow(RangeError);
    expect(() => computeQuote({ ...base, markupBp: -1 })).toThrow(RangeError);
    expect(() => computeQuote({ ...base, fxBufferBp: 1.5 })).toThrow(RangeError);
    expect(() => computeQuote({ ...base, fixedFeeMinor: -1n })).toThrow(RangeError);
  });
});

describe('rates', () => {
  it('parses and formats', () => {
    expect(parseRate('92,1234')).toBe(9_212_340_000n);
    expect(formatRate(9_212_340_000n)).toBe('92,1234');
    expect(formatRate(9_000_000_000n)).toBe('90,00');
    expect(() => parseRate('0')).toThrow(RangeError);
    expect(() => parseRate('1.123456789')).toThrow(RangeError);
    expect(() => parseRate('abc')).toThrow(RangeError);
  });
  it('round-trips through decimal strings', () => {
    expect(rateToDecimalString(9_212_340_000n)).toBe('92.12340000');
    expect(rateFromDecimalString('92.12340000')).toBe(9_212_340_000n);
    expect(rateFromDecimalString('5')).toBe(500_000_000n);
  });
});

describe('convertToRubMinor / settlementDiff', () => {
  it('rounds half up to kopecks', () => {
    expect(convertToRubMinor(1000n, parseRate('90'))).toBe(90_000n);
    expect(convertToRubMinor(1n, parseRate('0.5'))).toBe(1n); // 0.5 kop → 1
    expect(convertToRubMinor(1n, parseRate('0.49999999'))).toBe(0n);
  });
  it('positive diff = client overpaid', () => {
    expect(settlementDiff(91_800n, 90_000n)).toBe(1_800n);
    expect(settlementDiff(91_800n, 93_000n)).toBe(-1_200n);
    expect(settlementDiff(5n, 5n)).toBe(0n);
  });
});
