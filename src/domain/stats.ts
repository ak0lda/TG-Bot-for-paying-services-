import type { OrderStatus } from '@prisma/client';

/** Выполненная заявка в терминах отчёта (все суммы в копейках ₽, кроме *InCardCurrency). */
export interface DoneOrder {
  clientId: number;
  clientName: string;
  service: string;
  /** Выручка: итог, выставленный клиенту. */
  totalMinor: bigint;
  /** Фактическая стоимость для админа в ₽ (оценка себестоимости − разница по факту). */
  costMinor: bigint;
  cardLabel: string;
  cardCurrency: string;
  chargeInCardCurrencyMinor: bigint;
}

export interface Row {
  key: string;
  label: string;
  count: number;
  turnoverMinor: bigint;
}

export interface CardRow {
  label: string;
  currency: string;
  count: number;
  chargeMinor: bigint;
  rubMinor: bigint;
}

export interface Stats {
  count: number;
  turnoverMinor: bigint;
  costMinor: bigint;
  /** Валовая прибыль = выручка − фактическая стоимость (наценка + комиссия + курсовая разница). */
  profitMinor: bigint;
  byClient: Row[];
  byService: Row[];
  byCard: CardRow[];
}

function group(orders: DoneOrder[], keyOf: (o: DoneOrder) => [string, string]): Row[] {
  const map = new Map<string, Row>();
  for (const o of orders) {
    const [key, label] = keyOf(o);
    const row = map.get(key) ?? { key, label, count: 0, turnoverMinor: 0n };
    row.count += 1;
    row.turnoverMinor += o.totalMinor;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) =>
    a.turnoverMinor === b.turnoverMinor ? a.label.localeCompare(b.label) : a.turnoverMinor > b.turnoverMinor ? -1 : 1,
  );
}

export function buildStats(orders: DoneOrder[]): Stats {
  const turnoverMinor = orders.reduce((s, o) => s + o.totalMinor, 0n);
  const costMinor = orders.reduce((s, o) => s + o.costMinor, 0n);

  const cards = new Map<string, CardRow>();
  for (const o of orders) {
    const key = `${o.cardLabel}|${o.cardCurrency}`;
    const row = cards.get(key) ?? {
      label: o.cardLabel,
      currency: o.cardCurrency,
      count: 0,
      chargeMinor: 0n,
      rubMinor: 0n,
    };
    row.count += 1;
    row.chargeMinor += o.chargeInCardCurrencyMinor;
    row.rubMinor += o.costMinor;
    cards.set(key, row);
  }

  return {
    count: orders.length,
    turnoverMinor,
    costMinor,
    profitMinor: turnoverMinor - costMinor,
    byClient: group(orders, (o) => [String(o.clientId), `#${o.clientId} ${o.clientName}`]),
    // Сервисы считаем без учёта регистра и пробелов: «Netflix» и « netflix » — один сервис.
    byService: group(orders, (o) => [o.service.trim().toLowerCase(), o.service.trim()]),
    byCard: [...cards.values()].sort((a, b) => (a.rubMinor > b.rubMinor ? -1 : 1)),
  };
}

export type StatusCounts = Partial<Record<OrderStatus, number>>;
