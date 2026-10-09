import type { Db } from '../db/client.js';

type Reader = Pick<Db, 'ledgerEntry'>;

/** Баланс клиента — только сумма проводок журнала. Отрицательный = долг. */
export async function balanceOf(db: Reader, clientId: number): Promise<bigint> {
  const res = await db.ledgerEntry.aggregate({ where: { clientId }, _sum: { amountMinor: true } });
  return res._sum.amountMinor ?? 0n;
}
