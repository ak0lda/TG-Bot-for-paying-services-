import type { OrderType, PeriodKind } from '@prisma/client';
import type { Db } from '../db/client.js';

export interface Suggestion {
  name: string;
  type: OrderType;
  currency: string | null;
  amountMinor: bigint | null;
  periodKind: PeriodKind | null;
  periodDays: number | null;
  source: 'history' | 'preset';
}

/**
 * Подсказки сервисов для новой заявки: сначала то, что клиент уже оплачивал (с последними суммой и периодом),
 * затем «частые сервисы» от админа (ServicePreset). Дубликаты по названию (без учёта регистра) схлопываются.
 */
export async function suggestionsFor(db: Db, clientId: number, type?: OrderType, limit = 8): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (s: Suggestion) => {
    const key = s.name.trim().toLowerCase();
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push(s);
  };

  const recent = await db.order.findMany({
    where: { clientId, ...(type ? { type } : {}), status: { notIn: ['CANCELED', 'REJECTED'] } },
    orderBy: { id: 'desc' },
    take: 100,
  });
  for (const o of recent) {
    push({
      name: o.service,
      type: o.type,
      currency: o.currency,
      amountMinor: o.amountMinor,
      periodKind: o.isSubscription ? o.periodKind : null,
      periodDays: o.isSubscription ? o.periodDays : null,
      source: 'history',
    });
  }
  const presets = await db.servicePreset.findMany({
    where: type ? { type } : {},
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  for (const p of presets) {
    push({
      name: p.name,
      type: p.type,
      currency: p.currency,
      amountMinor: p.amountMinor,
      periodKind: p.periodKind,
      periodDays: p.periodDays,
      source: 'preset',
    });
  }
  return out;
}
