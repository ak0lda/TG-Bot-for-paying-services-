/**
 * Подбор «запаса на конвертацию» по фактам.
 *
 * Для каждой выполненной заявки считаем «проскальзывание»: насколько реальный расход в рублях отличался от
 * чистой конвертации по курсу расчёта (сумма × курс, без запаса): slip = (факт − чистая) / чистая, в б.п.
 * Запас B покрывает заявку, если slip ≤ B: тогда клиенту возвращается разница, иначе он доплачивает.
 * Разница по факту всегда урегулируется через баланс, поэтому запас не влияет на вашу прибыль — он определяет,
 * насколько предсказуема итоговая сумма для клиента (как часто и насколько ему приходится доплачивать).
 */
export interface FxSample {
  /** Проскальзывание в б.п. (может быть отрицательным, если факт оказался дешевле). */
  slipBp: number;
}

export interface FxAdvice {
  sample: number;
  /** Достаточно ли данных для рекомендации. */
  enough: boolean;
  currentBp: number;
  /** Доля заявок, где запас не хватил (клиент доплачивал), 0..1, при текущем запасе. */
  surchargeShare: number;
  medianBp: number;
  p90Bp: number;
  maxBp: number;
  /** Рекомендованный запас: покрывает 90% заявок, округлён вверх до 0,1%, в пределах 0..10%. */
  recommendedBp: number;
  /** Доля заявок с доплатой при рекомендованном запасе. */
  recommendedSurchargeShare: number;
}

export const MIN_SAMPLE = 10;

/** Метод «ближайшего ранга»: q-квантиль отсортированной выборки. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

const roundUp10 = (bp: number) => Math.ceil(bp / 10) * 10;
const share = (xs: readonly number[], f: (x: number) => boolean) => (xs.length ? xs.filter(f).length / xs.length : 0);

export function adviseFxBuffer(samples: readonly FxSample[], currentBp: number): FxAdvice {
  const slips = samples.map((s) => s.slipBp).sort((a, b) => a - b);
  const p90 = quantile(slips, 0.9);
  const recommendedBp = Math.min(1000, Math.max(0, roundUp10(p90)));
  return {
    sample: slips.length,
    enough: slips.length >= MIN_SAMPLE,
    currentBp,
    surchargeShare: share(slips, (x) => x > currentBp),
    medianBp: quantile(slips, 0.5),
    p90Bp: p90,
    maxBp: slips.length ? slips[slips.length - 1]! : 0,
    recommendedBp,
    recommendedSurchargeShare: share(slips, (x) => x > recommendedBp),
  };
}

/** Проскальзывание одной заявки, б.п.: (факт − чистая конвертация) / чистая конвертация, округление вверх. */
export function slipBp(actualRubMinor: bigint, pureRubMinor: bigint): number {
  if (pureRubMinor <= 0n) return 0;
  const diff = actualRubMinor - pureRubMinor;
  const n = diff * 10_000n;
  // округление вверх для обоих знаков (в сторону +∞)
  const q = n / pureRubMinor;
  return Number(n % pureRubMinor > 0n ? q + 1n : q);
}
