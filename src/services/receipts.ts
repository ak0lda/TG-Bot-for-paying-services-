import type { Db } from '../db/client.js';

export interface ReceiptDuplicate {
  kind: 'order' | 'topup';
  id: number;
  clientId: number;
  clientName: string;
  /** Чек прислан другим клиентом — особенно подозрительно. */
  otherClient: boolean;
}

/**
 * Повторное использование чека: тот же файл (file_unique_id) уже прикладывали к другой заявке или пополнению.
 * Ловит пересылку того же файла; новый скриншот того же перевода так не поймать — это лишь подсказка админу, а не запрет.
 */
export async function findDuplicateReceipts(
  db: Pick<Db, 'attachment'>,
  uniqueId: string | undefined,
  self: { orderId?: number; topUpId?: number; clientId: number },
): Promise<ReceiptDuplicate[]> {
  if (!uniqueId) return [];
  const rows = await db.attachment.findMany({
    where: { tgFileUniqueId: uniqueId, kind: 'RECEIPT' },
    include: { order: { include: { client: true } }, topUp: { include: { client: true } } },
    orderBy: { id: 'asc' },
  });
  const out: ReceiptDuplicate[] = [];
  for (const r of rows) {
    if (r.order && r.order.id !== self.orderId) {
      out.push({
        kind: 'order',
        id: r.order.id,
        clientId: r.order.clientId,
        clientName: r.order.client.displayName,
        otherClient: r.order.clientId !== self.clientId,
      });
    } else if (r.topUp && r.topUp.id !== self.topUpId) {
      out.push({
        kind: 'topup',
        id: r.topUp.id,
        clientId: r.topUp.clientId,
        clientName: r.topUp.client.displayName,
        otherClient: r.topUp.clientId !== self.clientId,
      });
    }
  }
  return out;
}
