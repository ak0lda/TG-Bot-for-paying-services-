import type { AdminCard, PaymentMethod } from '@prisma/client';
import type { Db } from '../db/client.js';

/** Справочники админа: способы перевода от клиентов и метки его карт (без реквизитов). */
export class CatalogService {
  constructor(private readonly db: Db) {}

  listMethods(onlyActive = false): Promise<PaymentMethod[]> {
    return this.db.paymentMethod.findMany({
      where: onlyActive ? { isActive: true } : {},
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }
  getMethod(id: number): Promise<PaymentMethod | null> {
    return this.db.paymentMethod.findUnique({ where: { id } });
  }
  async addMethod(title: string, instructions: string, requiresReceipt: boolean): Promise<PaymentMethod> {
    const last = await this.db.paymentMethod.aggregate({ _max: { sortOrder: true } });
    return this.db.paymentMethod.create({
      data: { title, instructions, requiresReceipt, sortOrder: (last._max.sortOrder ?? 0) + 1 },
    });
  }
  updateMethod(
    id: number,
    data: Partial<
      Pick<
        PaymentMethod,
        'title' | 'instructions' | 'requiresReceipt' | 'isActive' | 'autoSend' | 'minAmountMinor' | 'maxAmountMinor'
      >
    >,
  ) {
    return this.db.paymentMethod.update({ where: { id }, data });
  }

  listCards(onlyActive = false): Promise<AdminCard[]> {
    return this.db.adminCard.findMany({ where: onlyActive ? { isActive: true } : {}, orderBy: { id: 'asc' } });
  }
  getCard(id: number): Promise<AdminCard | null> {
    return this.db.adminCard.findUnique({ where: { id } });
  }
  addCard(label: string, currency: string): Promise<AdminCard> {
    return this.db.adminCard.create({ data: { label, currency } });
  }
  setCardActive(id: number, isActive: boolean): Promise<AdminCard> {
    return this.db.adminCard.update({ where: { id }, data: { isActive } });
  }
}
