import type { Db } from '../db/client.js';

/** Что сейчас ждёт денежного перевода (реквизиты уже отправлены клиенту). */
export interface Obligation {
  kind: 'order' | 'topup';
  id: number;
  /** Версия заявки — кнопка подтверждения привязана к ней (защита от двойного нажатия и устаревших карточек). */
  version: number | null;
  clientId: number;
  clientName: string;
  amountMinor: bigint;
  createdAt: Date;
  title: string;
}

export async function openObligations(db: Pick<Db, 'order' | 'topUp'>): Promise<Obligation[]> {
  const orders = await db.order.findMany({
    where: {
      OR: [{ status: 'PAYMENT_CHECK' }, { status: 'AWAITING_PAYMENT', payMethodId: { not: null } }],
      payMode: { in: ['PREPAY', 'BALANCE'] },
    },
    include: { client: true },
    orderBy: { id: 'asc' },
  });
  const topUps = await db.topUp.findMany({
    where: { status: 'PENDING', kind: 'TRANSFER', methodId: { not: null } },
    include: { client: true },
    orderBy: { id: 'asc' },
  });
  const out: Obligation[] = [];
  for (const o of orders) {
    const amount = o.payDueMinor ?? o.totalMinor;
    if (amount == null || amount <= 0n) continue;
    out.push({
      kind: 'order',
      id: o.id,
      version: o.version,
      clientId: o.clientId,
      clientName: o.client.displayName,
      amountMinor: amount,
      createdAt: o.createdAt,
      title: `заявка #${o.id} — ${o.service}`,
    });
  }
  for (const t of topUps) {
    out.push({
      kind: 'topup',
      id: t.id,
      version: null,
      clientId: t.clientId,
      clientName: t.client.displayName,
      amountMinor: t.amountMinor,
      createdAt: t.createdAt,
      title: `пополнение #${t.id}`,
    });
  }
  return out;
}

/** Точное совпадение суммы; при нескольких — старшие первыми (их ждут дольше). */
export const matchAmount = (obligations: readonly Obligation[], amountMinor: bigint): Obligation[] =>
  obligations
    .filter((o) => o.amountMinor === amountMinor)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
