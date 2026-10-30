export type RateWarning =
  /** ЦБ давно не отвечает: расчёт пойдёт по устаревшему курсу. */
  | { kind: 'stale'; ageHours: number }
  /** Курс ЦБ резко изменился между обновлениями. */
  | { kind: 'jump'; fromScaled: bigint; toScaled: bigint; changeBp: number; at: Date }
  /** Ручной курс давно не обновлялся, но по-прежнему перекрывает ЦБ. */
  | { kind: 'manual_old'; ageDays: number; scaled: bigint }
  /** Ручной курс заметно расходится с курсом ЦБ. */
  | { kind: 'manual_diverged'; manualScaled: bigint; cbrScaled: bigint; changeBp: number };

export interface RateThresholds {
  /** Порог «резкого» изменения, б.п. (500 = 5%). */
  jumpBp: number;
  staleHours: number;
  manualOldDays: number;
  /** Сколько часов предупреждение о скачке остаётся актуальным. */
  jumpActiveHours: number;
  /** После осознанного «рассчитать всё равно» предупреждения по этой валюте не повторяются столько часов. */
  ackHours: number;
}

export const DEFAULT_THRESHOLDS: RateThresholds = { jumpBp: 500, staleHours: 6, manualOldDays: 3, jumpActiveHours: 24, ackHours: 1 };

/** |to − from| / from в базисных пунктах, округление вверх. */
export function changeBp(from: bigint, to: bigint): number {
  if (from <= 0n) return 0;
  const diff = to > from ? to - from : from - to;
  return Number((diff * 10_000n + from - 1n) / from);
}

export interface AssessInput {
  source: 'CBR' | 'MANUAL';
  scaled: bigint;
  /** Когда получен курс ЦБ / когда задан ручной курс. */
  rateAt: Date;
  now: Date;
  jump: { fromScaled: bigint; toScaled: bigint; at: Date } | null;
  ackAt: Date | null;
  /** Актуальный курс ЦБ (для сравнения с ручным), если известен. */
  cbrScaled: bigint | null;
}

const HOUR = 3_600_000;

export function assessRate(i: AssessInput, th: RateThresholds = DEFAULT_THRESHOLDS): RateWarning[] {
  if (i.ackAt && i.now.getTime() - i.ackAt.getTime() < th.ackHours * HOUR) return [];

  const out: RateWarning[] = [];
  if (i.source === 'CBR') {
    const ageH = (i.now.getTime() - i.rateAt.getTime()) / HOUR;
    if (ageH > th.staleHours) out.push({ kind: 'stale', ageHours: Math.floor(ageH) });
    if (i.jump && i.now.getTime() - i.jump.at.getTime() < th.jumpActiveHours * HOUR) {
      out.push({ kind: 'jump', fromScaled: i.jump.fromScaled, toScaled: i.jump.toScaled, changeBp: changeBp(i.jump.fromScaled, i.jump.toScaled), at: i.jump.at });
    }
  } else {
    const ageD = (i.now.getTime() - i.rateAt.getTime()) / (24 * HOUR);
    if (ageD > th.manualOldDays) out.push({ kind: 'manual_old', ageDays: Math.floor(ageD), scaled: i.scaled });
    if (i.cbrScaled) {
      const bp = changeBp(i.cbrScaled, i.scaled);
      if (bp >= th.jumpBp) out.push({ kind: 'manual_diverged', manualScaled: i.scaled, cbrScaled: i.cbrScaled, changeBp: bp });
    }
  }
  return out;
}
