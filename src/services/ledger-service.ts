import type { LedgerEntry } from '@prisma/client';
import type { Db } from '../db/client.js';

type Reader = Pick<Db, 'ledgerEntry'>;

/** Баланс клиента — только сумма проводок журнала. Отрицательный = долг. */
export async function balanceOf(db: Reader, clientId: number): Promise<bigint> {
  const res = await db.ledgerEntry.aggregate({ where: { clientId }, _sum: { amountMinor: true } });
  return res._sum.amountMinor ?? 0n;
}

/** Балансы всех клиентов, у которых есть проводки. */
export async function balancesByClient(db: Reader): Promise<Map<number, bigint>> {
  const rows = await db.ledgerEntry.groupBy({ by: ['clientId'], _sum: { amountMinor: true } });
  return new Map(rows.map((r) => [r.clientId, r._sum.amountMinor ?? 0n]));
}

export function ledgerHistory(db: Reader, clientId: number, take = 10): Promise<LedgerEntry[]> {
  return db.ledgerEntry.findMany({ where: { clientId }, orderBy: { id: 'desc' }, take });
}

/** Блокирует строку клиента до конца транзакции: сериализует операции с его балансом и лимитом. */
export async function lockClient(tx: { $queryRaw: Db['$queryRaw'] }, clientId: number): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${clientId} FOR UPDATE`;
}
