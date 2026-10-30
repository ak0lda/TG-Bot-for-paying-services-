import { describe, expect, it } from 'vitest';
import { doneEntries, sumEntries } from '../src/domain/ledger.js';
import { addPeriod } from '../src/domain/period.js';

describe('ledger helpers', () => {
  it('sums signed entries', () => {
    expect(sumEntries([])).toBe(0n);
    expect(sumEntries([{ amountMinor: 500n }, { amountMinor: -200n }])).toBe(300n);
  });

  it('prepay lifecycle nets to the diff only', () => {
    const total = 101_400n;
    const entries = [{ amountMinor: total }, ...doneEntries(total, 1_800n)]; // PAYMENT_RECEIVED + charge + diff
    expect(sumEntries(entries)).toBe(1_800n);
  });

  it('no DIFF entry when diff is zero; negative diff is a debit', () => {
    expect(doneEntries(100n, 0n).map((e) => e.type)).toEqual(['ORDER_CHARGE']);
    const neg = doneEntries(100n, -50n);
    expect(neg[1]).toMatchObject({ type: 'DIFF_ADJUST', amountMinor: -50n });
    expect(() => doneEntries(0n, 0n)).toThrow(RangeError);
  });
});

describe('addPeriod', () => {
  const d = (s: string) => new Date(`${s}T12:00:00Z`);
  it('adds calendar months, clamping month end', () => {
    expect(addPeriod(d('2026-01-31'), 'MONTH').toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addPeriod(d('2026-03-15'), 'MONTH').toISOString().slice(0, 10)).toBe('2026-04-15');
    expect(addPeriod(d('2026-12-31'), 'MONTH').toISOString().slice(0, 10)).toBe('2027-01-31');
  });
  it('adds years, incl. leap day', () => {
    expect(addPeriod(d('2028-02-29'), 'YEAR').toISOString().slice(0, 10)).toBe('2029-02-28');
  });
  it('adds custom days', () => {
    expect(addPeriod(d('2026-01-30'), 'CUSTOM', 10).toISOString().slice(0, 10)).toBe('2026-02-09');
    expect(() => addPeriod(d('2026-01-01'), 'CUSTOM')).toThrow(RangeError);
  });
});

import { availableOf, debtOf, payLaterExposure, topUpEntries } from '../src/domain/ledger.js';

describe('ledger: reserves, debt, top-ups', () => {
  it('BALANCE: reserve is released then charged — net effect is just the charge + diff', () => {
    const total = 50_000n;
    const entries = [{ amountMinor: -total }, ...doneEntries(total, 300n, { reservedMinor: total })]; // reserve + done
    expect(doneEntries(total, 300n, { reservedMinor: total }).map((e) => e.type)).toEqual([
      'ORDER_RELEASE',
      'ORDER_CHARGE',
      'DIFF_ADJUST',
    ]);
    expect(sumEntries(entries)).toBe(-total + 300n);
  });

  it('PAY_LATER: charge becomes DEBT_OPEN', () => {
    const e = doneEntries(10_000n, -500n, { payLater: true });
    expect(e.map((x) => x.type)).toEqual(['DEBT_OPEN', 'DIFF_ADJUST']);
    expect(sumEntries(e)).toBe(-10_500n);
  });

  it('debt / available', () => {
    expect(debtOf(-700n)).toBe(700n);
    expect(debtOf(0n)).toBe(0n);
    expect(debtOf(500n)).toBe(0n);
    expect(availableOf(-5n)).toBe(0n);
    expect(availableOf(900n)).toBe(900n);
  });

  it('pay-later exposure counts open orders and offsets positive balance', () => {
    expect(payLaterExposure(0n, 0n, 1000n)).toBe(1000n);
    expect(payLaterExposure(-300n, 200n, 1000n)).toBe(1500n);
    expect(payLaterExposure(5000n, 0n, 1000n)).toBe(0n);
    expect(payLaterExposure(400n, 0n, 1000n)).toBe(600n);
  });

  it('top-up repays debt first, remainder goes to balance', () => {
    expect(topUpEntries(1000n, 0n).map((e) => [e.type, e.amountMinor])).toEqual([['TOPUP', 1000n]]);
    expect(topUpEntries(1000n, -300n).map((e) => [e.type, e.amountMinor])).toEqual([
      ['DEBT_REPAY', 300n],
      ['TOPUP', 700n],
    ]);
    expect(topUpEntries(200n, -300n).map((e) => [e.type, e.amountMinor])).toEqual([['DEBT_REPAY', 200n]]);
    expect(topUpEntries(300n, -300n).map((e) => e.type)).toEqual(['DEBT_REPAY']);
    expect(() => topUpEntries(0n, 0n)).toThrow(RangeError);
  });
});
