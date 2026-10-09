import type { PaymentMethod, TopUp, User } from '@prisma/client';
import type { Db } from '../db/client.js';
import { topUpEntries } from '../domain/ledger.js';
import { balanceOf, lockClient } from './ledger-service.js';
import type { Attached } from './order-service.js';

export type TopUpWithClient = TopUp & { client: User; method: PaymentMethod | null };

export class TopUpNotPendingError extends Error {}

export class TopUpService {
  constructor(private readonly db: Db) {}

  get(id: number): Promise<TopUpWithClient | null> {
    return this.db.topUp.findUnique({ where: { id }, include: { client: true, method: true } });
  }

  receiptCount(topUpId: number): Promise<number> {
    return this.db.attachment.count({ where: { topUpId } });
  }

  pendingCount(clientId: number): Promise<number> {
    return this.db.topUp.count({ where: { clientId, status: 'PENDING' } });
  }

  /** Заявка на пополнение: способ и реквизиты пока не выбраны — их присылает админ. */
  async create(clientId: number, amountMinor: bigint): Promise<TopUpWithClient> {
    return this.db.topUp.create({ data: { clientId, amountMinor }, include: { client: true, method: true } });
  }

  /** Админ выбрал способ и отправил реквизиты (сам текст не сохраняется). Только для ещё не обработанных пополнений. */
  async setMethod(id: number, methodId: number): Promise<TopUpWithClient> {
    const res = await this.db.topUp.updateMany({ where: { id, status: 'PENDING' }, data: { methodId } });
    if (res.count !== 1) throw new TopUpNotPendingError();
    return (await this.get(id))!;
  }

  /** Клиент прислал чек (file_id) — прикрепляем к своему необработанному пополнению. */
  async addReceipt(id: number, clientId: number, receipt: Attached): Promise<TopUpWithClient> {
    const t = await this.db.topUp.findFirst({ where: { id, clientId, status: 'PENDING' } });
    if (!t) throw new TopUpNotPendingError();
    await this.db.attachment.create({
      data: { topUpId: id, kind: 'RECEIPT', tgFileId: receipt.fileId, tgFileType: receipt.fileType, uploadedById: clientId },
    });
    return (await this.get(id))!;
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
      const topUp = await tx.topUp.findUniqueOrThrow({ where: { id }, include: { client: true, method: true } });
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
