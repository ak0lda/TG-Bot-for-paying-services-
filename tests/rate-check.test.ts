import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, assessRate, changeBp, type AssessInput } from '../src/domain/rate-check.js';
import { parseRate } from '../src/domain/pricing.js';

const now = new Date('2026-10-30T12:00:00Z');
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
const base: AssessInput = { source: 'CBR', scaled: parseRate('92'), rateAt: ago(0.5), now, jump: null, ackAt: null, cbrScaled: null };

describe('changeBp', () => {
  it('measures relative change in basis points, rounding up', () => {
    expect(changeBp(parseRate('100'), parseRate('105'))).toBe(500);
    expect(changeBp(parseRate('100'), parseRate('95'))).toBe(500);
    expect(changeBp(parseRate('92'), parseRate('92'))).toBe(0);
    expect(changeBp(parseRate('92'), parseRate('92.01'))).toBe(2); // 1.09 б.п. -> вверх
    expect(changeBp(0n, 5n)).toBe(0);
  });
});

describe('assessRate', () => {
  it('fresh CBR rate: no warnings', () => {
    expect(assessRate(base)).toEqual([]);
  });

  it('stale CBR rate', () => {
    expect(assessRate({ ...base, rateAt: ago(5) })).toEqual([]);
    expect(assessRate({ ...base, rateAt: ago(7.5) })).toEqual([{ kind: 'stale', ageHours: 7 }]);
  });

  it('recent jump warns, old jump does not, acknowledgement silences everything for an hour', () => {
    const jump = { fromScaled: parseRate('90'), toScaled: parseRate('96'), at: ago(3) };
    expect(assessRate({ ...base, jump })).toMatchObject([{ kind: 'jump', changeBp: 667 }]);
    expect(assessRate({ ...base, jump: { ...jump, at: ago(30) } })).toEqual([]);
    expect(assessRate({ ...base, jump, rateAt: ago(10), ackAt: ago(0.5) })).toEqual([]);
    expect(assessRate({ ...base, jump, ackAt: ago(2) })).toHaveLength(1); // подтверждение устарело
  });

  it('manual rate: old and/or diverged from CBR; CBR-only warnings do not apply', () => {
    const manual: AssessInput = { ...base, source: 'MANUAL', scaled: parseRate('95'), rateAt: ago(24 * 5), jump: { fromScaled: 1n, toScaled: 2n, at: ago(1) } };
    expect(assessRate(manual)).toEqual([{ kind: 'manual_old', ageDays: 5, scaled: parseRate('95') }]);
    expect(assessRate({ ...manual, rateAt: ago(24), cbrScaled: parseRate('94') })).toEqual([]); // ~1,06% — норма
    expect(assessRate({ ...manual, rateAt: ago(24), cbrScaled: parseRate('88') })).toMatchObject([{ kind: 'manual_diverged', changeBp: 796 }]);
    expect(assessRate({ ...manual, cbrScaled: parseRate('88') }).map((w) => w.kind)).toEqual(['manual_old', 'manual_diverged']);
  });

  it('thresholds are configurable', () => {
    const th = { ...DEFAULT_THRESHOLDS, staleHours: 1, jumpBp: 100 };
    expect(assessRate({ ...base, rateAt: ago(2) }, th)).toHaveLength(1);
    expect(assessRate({ ...base, source: 'MANUAL', rateAt: ago(1), cbrScaled: parseRate('93') }, th)).toMatchObject([{ kind: 'manual_diverged' }]);
  });
});
