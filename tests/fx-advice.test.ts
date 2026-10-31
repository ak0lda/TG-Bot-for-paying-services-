import { describe, expect, it } from 'vitest';
import { MIN_SAMPLE, adviseFxBuffer, quantile, slipBp } from '../src/domain/fx-advice.js';

const mk = (xs: number[]) => xs.map((slipBp) => ({ slipBp }));

describe('slipBp', () => {
  it('measures actual vs pure conversion in basis points, rounding up', () => {
    expect(slipBp(90_900n, 90_000n)).toBe(100); // +1%
    expect(slipBp(90_000n, 90_000n)).toBe(0);
    expect(slipBp(89_100n, 90_000n)).toBe(-100); // дешевле чистой конвертации
    expect(slipBp(90_001n, 90_000n)).toBe(1); // 0,11 б.п. -> вверх
    expect(slipBp(100n, 0n)).toBe(0);
  });
});

describe('quantile', () => {
  it('nearest rank', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(s, 0.5)).toBe(5);
    expect(quantile(s, 0.9)).toBe(9);
    expect(quantile(s, 1)).toBe(10);
    expect(quantile([], 0.9)).toBe(0);
    expect(quantile([7], 0.9)).toBe(7);
  });
});

describe('adviseFxBuffer', () => {
  it('recommends a buffer that covers ~90% of orders, rounded up to 0.1%', () => {
    // 20 заявок: большинство около +0,3…0,6%, две выбросные
    const slips = [10, 20, 25, 30, 30, 35, 40, 40, 45, 45, 50, 50, 55, 55, 60, 60, 65, 70, 150, 240];
    const a = adviseFxBuffer(mk(slips), 200);
    expect(a).toMatchObject({ sample: 20, enough: true, currentBp: 200, medianBp: 45, p90Bp: 70, maxBp: 240, recommendedBp: 70 });
    expect(a.surchargeShare).toBeCloseTo(0.05, 5); // при 2%: доплата только в 1 из 20 (240 б.п.)
    expect(a.recommendedSurchargeShare).toBeCloseTo(0.1, 5); // при 0,7%: 2 из 20 (150 и 240)
  });

  it('rounds up to a whole 0.1% and clamps to 0..10%', () => {
    expect(adviseFxBuffer(mk(Array(12).fill(73)), 0).recommendedBp).toBe(80);
    expect(adviseFxBuffer(mk(Array(12).fill(-50)), 200).recommendedBp).toBe(0); // всегда дешевле — запас не нужен
    expect(adviseFxBuffer(mk(Array(12).fill(5000)), 200).recommendedBp).toBe(1000);
  });

  it('flags a too-small sample and handles an empty one', () => {
    expect(adviseFxBuffer(mk([10, 20, 30]), 200).enough).toBe(false);
    expect(MIN_SAMPLE).toBe(10);
    expect(adviseFxBuffer([], 200)).toMatchObject({ sample: 0, enough: false, recommendedBp: 0, surchargeShare: 0 });
  });

  it('current buffer too small => many surcharges, recommendation is higher', () => {
    const a = adviseFxBuffer(mk(Array.from({ length: 20 }, (_, i) => 100 + i * 5)), 50);
    expect(a.surchargeShare).toBe(1);
    expect(a.recommendedBp).toBeGreaterThan(50);
    expect(a.recommendedSurchargeShare).toBeLessThanOrEqual(0.1);
  });
});
