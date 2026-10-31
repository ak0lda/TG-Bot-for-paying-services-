import { describe, expect, it } from 'vitest';
import { parsePreset } from '../src/domain/preset-parse.js';

describe('parsePreset', () => {
  it('parses a full preset', () => {
    expect(parsePreset('Netflix | PAYMENT_LINK | usd | 15,99 | MONTH')).toEqual({
      name: 'Netflix',
      type: 'PAYMENT_LINK',
      currency: 'USD',
      amountMinor: 1599n,
      periodKind: 'MONTH',
      periodDays: null,
    });
  });
  it('everything but the name is optional; dashes mean "not set"', () => {
    expect(parsePreset('Steam')).toEqual({
      name: 'Steam',
      type: 'PAYMENT_LINK',
      currency: null,
      amountMinor: null,
      periodKind: null,
      periodDays: null,
    });
    expect(parsePreset('Steam | GIFT_CARD | - | - | -')).toMatchObject({ type: 'GIFT_CARD', currency: null });
    expect(parsePreset('VPS | TOP_UP | EUR | 5 | CUSTOM:30')).toMatchObject({ periodKind: 'CUSTOM', periodDays: 30 });
    expect(parsePreset('One-off | OTHER | USD | 10 | ONE')).toMatchObject({ periodKind: null });
  });
  it.each([
    ['x', /Название/],
    ['Netflix | NOPE', /Тип/],
    ['Netflix | PAYMENT_LINK | RUB', /Валюта/],
    ['Netflix | PAYMENT_LINK | us', /Валюта/],
    ['Netflix | PAYMENT_LINK | USD | abc', /Сумма: число/],
    ['Netflix | PAYMENT_LINK | - | 10', /вместе с валютой/],
    ['Netflix | PAYMENT_LINK | USD | 0', /диапазона/],
    ['Netflix | PAYMENT_LINK | USD | 10 | WEEKLY', /Период/],
    ['Netflix | PAYMENT_LINK | USD | 10 | CUSTOM:0', /Период/],
  ])('rejects %j', (input, re) => {
    const r = parsePreset(input);
    expect('error' in r && r.error).toMatch(re);
  });
});
