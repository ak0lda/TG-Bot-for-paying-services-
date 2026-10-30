import { describe, expect, it } from 'vitest';
import { inLimits, pickAutoMethod, type AutoMethod } from '../src/domain/auto-requisites.js';

const m = (p: Partial<AutoMethod> & { id: number }): AutoMethod => ({
  title: `M${p.id}`,
  isActive: true,
  autoSend: true,
  instructions: 'реквизиты',
  minAmountMinor: null,
  maxAmountMinor: null,
  sortOrder: p.id,
  ...p,
});

describe('inLimits', () => {
  it('is inclusive and treats null as unbounded', () => {
    const lim = { minAmountMinor: 580_000n, maxAmountMinor: 64_000_000n };
    expect(inLimits(lim, 579_999n)).toBe(false);
    expect(inLimits(lim, 580_000n)).toBe(true);
    expect(inLimits(lim, 64_000_000n)).toBe(true);
    expect(inLimits(lim, 64_000_001n)).toBe(false);
    expect(inLimits({ minAmountMinor: null, maxAmountMinor: null }, 1n)).toBe(true);
    expect(inLimits({ minAmountMinor: 100n, maxAmountMinor: null }, 99n)).toBe(false);
  });
});

describe('pickAutoMethod', () => {
  const sbp = m({ id: 1, maxAmountMinor: 579_999n }); // до 5 799,99 ₽
  const direct = m({ id: 2, minAmountMinor: 580_000n, maxAmountMinor: 64_000_000n }); // 5 800 – 640 000 ₽

  it('chooses the method whose limits fit the amount', () => {
    expect(pickAutoMethod([sbp, direct], 96_400n).method?.id).toBe(1);
    expect(pickAutoMethod([sbp, direct], 674_800n).method?.id).toBe(2);
    expect(pickAutoMethod([direct, sbp], 96_400n).method?.id).toBe(1); // порядок входа не важен
  });

  it('returns null (manual flow) when nothing fits, and says whether auto candidates existed', () => {
    expect(pickAutoMethod([sbp, direct], 70_000_000n)).toEqual({ method: null, hadCandidates: true });
    expect(pickAutoMethod([], 100n)).toEqual({ method: null, hadCandidates: false });
  });

  it('ignores inactive, non-auto and empty-text methods', () => {
    const list = [m({ id: 1, isActive: false }), m({ id: 2, autoSend: false }), m({ id: 3, instructions: '   ' })];
    expect(pickAutoMethod(list, 100n)).toEqual({ method: null, hadCandidates: false });
  });

  it('on overlap takes the first by sortOrder, then id', () => {
    expect(
      pickAutoMethod([m({ id: 5, sortOrder: 2 }), m({ id: 6, sortOrder: 1 }), m({ id: 4, sortOrder: 1 })], 100n).method
        ?.id,
    ).toBe(4);
  });
});
