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

export interface DoneOptions {
  /** Сумма, зарезервированная под заявку (режим BALANCE): сначала снимаем резерв, затем списываем. */
  reservedMinor?: bigint;
  /** PAY_LATER: списание превращается в долг (DEBT_OPEN). */
  payLater?: boolean;
}

/** Проводки при выполнении заявки: (снятие резерва) + списание по расчёту + (если есть) разница по факту. */
export function doneEntries(totalMinor: bigint, diffMinor: bigint, opts: DoneOptions = {}): LedgerInput[] {
  if (totalMinor <= 0n) throw new RangeError('total must be positive');
  const entries: LedgerInput[] = [];
  const reserved = opts.reservedMinor ?? 0n;
  if (reserved > 0n) entries.push({ type: 'ORDER_RELEASE', amountMinor: reserved, comment: 'Снятие резерва' });
  entries.push(
    opts.payLater
      ? { type: 'DEBT_OPEN', amountMinor: -totalMinor, comment: 'Оплата позже: долг по заявке' }
      : { type: 'ORDER_CHARGE', amountMinor: -totalMinor },
  );
  if (diffMinor !== 0n) {
    entries.push({
      type: 'DIFF_ADJUST',
      amountMinor: diffMinor,
      comment: diffMinor > 0n ? 'Переплата по факту списания' : 'Доплата по факту списания',
    });
  }
  return entries;
}

/** Долг клиента = отрицательный баланс. */
export const debtOf = (balanceMinor: bigint): bigint => (balanceMinor < 0n ? -balanceMinor : 0n);

/** Доступно к резервированию: только положительная часть баланса. */
export const availableOf = (balanceMinor: bigint): bigint => (balanceMinor > 0n ? balanceMinor : 0n);

/**
 * Экспозиция PAY_LATER после новой заявки: что клиент будет должен, если все открытые заявки «в долг»
 * будут выполнены, а баланс останется прежним.
 */
export function payLaterExposure(balanceMinor: bigint, openPayLaterMinor: bigint, newTotalMinor: bigint): bigint {
  const e = openPayLaterMinor + newTotalMinor - balanceMinor;
  return e > 0n ? e : 0n;
}

/** Разбор пополнения: сначала гасим долг (DEBT_REPAY), остаток — на баланс (TOPUP). */
export function topUpEntries(amountMinor: bigint, balanceBeforeMinor: bigint): LedgerInput[] {
  if (amountMinor <= 0n) throw new RangeError('amount must be positive');
  const debt = debtOf(balanceBeforeMinor);
  const repay = amountMinor < debt ? amountMinor : debt;
  const entries: LedgerInput[] = [];
  if (repay > 0n) entries.push({ type: 'DEBT_REPAY', amountMinor: repay, comment: 'Погашение долга' });
  if (amountMinor - repay > 0n) entries.push({ type: 'TOPUP', amountMinor: amountMinor - repay, comment: 'Пополнение баланса' });
  return entries;
}
