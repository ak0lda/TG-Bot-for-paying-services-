import { describe, expect, it } from 'vitest';
import { ceilToWholeRubles, formatMinor, formatRub, MoneyParseError, parseDecimalToMinor } from '../src/domain/money.js';

describe('parseDecimalToMinor', () => {
  it.each([
    ['5', 500n],
    ['5.5', 550n],
    ['5,05', 505n],
    ['1 200,10', 120010n],
    ['0.01', 1n],
    [' 7 ', 700n],
  ])('parses %s', (input, expected) => expect(parseDecimalToMinor(input)).toBe(expected));

  it.each(['', 'abc', '-5', '1.234', '1..2', '1,2,3', '€5'])('rejects %j', (input) =>
    expect(() => parseDecimalToMinor(input)).toThrow(MoneyParseError),
  );

  it('does not lose precision on huge values', () => {
    expect(parseDecimalToMinor('90071992547409.93')).toBe(9007199254740993n);
  });

  it('supports other exponents', () => {
    expect(parseDecimalToMinor('1.5', 3)).toBe(1500n);
    expect(parseDecimalToMinor('100', 0)).toBe(100n);
  });
});

describe('formatMinor', () => {
  it('formats with grouping and drops zero kopecks', () => {
    expect(formatMinor(123456789n)).toBe('1 234 567,89');
    expect(formatMinor(500n)).toBe('5');
    expect(formatMinor(5n)).toBe('0,05');
    expect(formatRub(120000n)).toBe('1 200 ₽');
  });
  it('formats negatives', () => {
    expect(formatMinor(-150n)).toBe('−1,50');
  });
});

describe('ceilToWholeRubles', () => {
  it.each([
    [0n, 0n],
    [100n, 100n],
    [101n, 200n],
    [199n, 200n],
    [12345n, 12400n],
  ])('%s -> %s', (input, expected) => expect(ceilToWholeRubles(input)).toBe(expected));
});
