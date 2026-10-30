export interface AutoMethod {
  id: number;
  title: string;
  isActive: boolean;
  autoSend: boolean;
  /** Готовый текст реквизитов (хранится в БД; номера банковских карт в нём запрещены). */
  instructions: string;
  minAmountMinor: bigint | null;
  maxAmountMinor: bigint | null;
  sortOrder: number;
}

export interface AutoPick<T extends AutoMethod> {
  /** Подходящий способ или null. */
  method: T | null;
  /** Есть ли вообще способы, готовые к автоотправке (чтобы объяснить админу, почему автоотправка не сработала). */
  hadCandidates: boolean;
}

export const inLimits = (m: Pick<AutoMethod, 'minAmountMinor' | 'maxAmountMinor'>, amountMinor: bigint): boolean =>
  (m.minAmountMinor === null || amountMinor >= m.minAmountMinor) &&
  (m.maxAmountMinor === null || amountMinor <= m.maxAmountMinor);

/**
 * Автовыбор способа по сумме: активный, с включённой автоотправкой, с непустым готовым текстом и границами,
 * в которые попадает сумма. Из подходящих берётся первый по порядку (sortOrder, затем id).
 */
export function pickAutoMethod<T extends AutoMethod>(methods: readonly T[], amountMinor: bigint): AutoPick<T> {
  const candidates = methods
    .filter((m) => m.isActive && m.autoSend && m.instructions.trim().length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  return { method: candidates.find((m) => inLimits(m, amountMinor)) ?? null, hadCandidates: candidates.length > 0 };
}
