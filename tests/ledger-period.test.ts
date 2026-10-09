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
