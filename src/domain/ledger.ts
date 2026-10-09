import type { LedgerType } from '@prisma/client';

export interface LedgerInput {
  type: LedgerType;
  /** Знаковая сумма в копейках: + увеличивает баланс клиента, − уменьшает. */
  amountMinor: bigint;
  comment?: string;
}

/** Баланс = сумма операций. Отрицательный баланс — долг клиента. */
export function sumEntries(entries: ReadonlyArray<{ amountMinor: bigint }>): bigint {
  return entries.reduce((acc, e) => acc + e.amountMinor, 0n);
}

/** Проводки при выполнении заявки: списание по расчёту + (если есть) разница по факту. */
export function doneEntries(totalMinor: bigint, diffMinor: bigint): LedgerInput[] {
  if (totalMinor <= 0n) throw new RangeError('total must be positive');
  const entries: LedgerInput[] = [{ type: 'ORDER_CHARGE', amountMinor: -totalMinor }];
  if (diffMinor !== 0n) {
    entries.push({
      type: 'DIFF_ADJUST',
      amountMinor: diffMinor,
      comment: diffMinor > 0n ? 'Переплата по факту списания' : 'Доплата по факту списания',
    });
  }
  return entries;
}
