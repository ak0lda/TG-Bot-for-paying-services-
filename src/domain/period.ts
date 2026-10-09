import type { PeriodKind } from '@prisma/client';

/** Следующая дата списания подписки: месяц/год — календарно (с «прижатием» конца месяца), свой период — в днях. */
export function addPeriod(from: Date, kind: PeriodKind, customDays?: number | null): Date {
  const d = new Date(from.getTime());
  if (kind === 'CUSTOM') {
    if (!customDays || customDays < 1) throw new RangeError('customDays required');
    d.setUTCDate(d.getUTCDate() + customDays);
    return d;
  }
  const months = kind === 'MONTH' ? 1 : 12;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}
