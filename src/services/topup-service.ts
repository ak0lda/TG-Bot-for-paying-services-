import type { TopUp, User } from '@prisma/client';
import type { Db } from '../db/client.js';
import { topUpEntries } from '../domain/ledger.js';
import { balanceOf, lockClient } from './ledger-service.js';
import type { Attached } from './order-service.js';

export type TopUpWithClient = TopUp & { client: User };

export class TopUpService {
  constructor(private readonly db: Db) {}

  get(id: number): Promise<TopUpWithClient | null> {
    return this.db.topUp.findUnique({ where: { id }, include: { client: true } });
  }

  pendingCount(clientId: number): Promise<number> {
    return this.db.topUp.count({ where: { clientId, status: 'PENDING' } });
  }

  async create(clientId: number, amountMinor: bigint, methodId: number, receipt?: Attached): Promise<TopUpWithClient> {
    return this.db.$transaction(async (tx) => {
      const topUp = await tx.topUp.create({ data: { clientId, amountMinor, methodId }, include: { client: true } });
      if (receipt) {
        await tx.attachment.create({
          data: { topUpId: topUp.id, kind: 'RECEIPT', tgFileId: receipt.fileId, tgFileType: receipt.fileType, uploadedById: clientId },
        });
      }
      return topUp;
    });
  }

  /**
   * Подтверждение пополнения. Идемпотентно: обрабатывается только PENDING.
   * Если у клиента долг — сначала погашаем его (DEBT_REPAY), остаток зачисляем (TOPUP).
   */
  async confirm(id: number, adminId: number): Promise<{ topUp: TopUpWithClient; balanceMinor: bigint } | null> {
    return this.db.$transaction(async (tx) => {
      const claimed = await tx.topUp.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'CONFIRMED', confirmedById: adminId },
      });
      if (claimed.count !== 1) return null;
      const topUp = await tx.topUp.findUniqueOrThrow({ where: { id }, include: { client: true } });
      await lockClient(tx, topUp.clientId);
      const before = await balanceOf(tx, topUp.clientId);
      for (const e of topUpEntries(topUp.amountMinor, before)) {
        await tx.ledgerEntry.create({
          data: {
            clientId: topUp.clientId, topUpId: id, type: e.type, amountMinor: e.amountMinor,
            comment: e.comment ?? null, createdById: adminId,
          },
        });
      }
      return { topUp, balanceMinor: await balanceOf(tx, topUp.clientId) };
    });
  }

  async reject(id: number, adminId: number): Promise<TopUpWithClient | null> {
    const res = await this.db.topUp.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', confirmedById: adminId },
    });
    return res.count === 1 ? this.get(id) : null;
  }

  /** Ручная корректировка баланса админом (MANUAL_ADJUST). */
  async adjust(clientId: number, amountMinor: bigint, adminId: number, comment: string | null): Promise<bigint> {
    return this.db.$transaction(async (tx) => {
      await lockClient(tx, clientId);
      await tx.ledgerEntry.create({
        data: { clientId, type: 'MANUAL_ADJUST', amountMinor, comment, createdById: adminId },
      });
      return balanceOf(tx, clientId);
    });
  }
}
