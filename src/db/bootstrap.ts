import type { Db } from './client.js';
import { DEFAULT_TRUSTED_DOMAINS } from '../domain/domains.js';

const FLAG = 'bootstrapped';

/** Один раз заполняет справочники значениями по умолчанию. Дальше ими управляет админ. */
export async function bootstrapDefaults(db: Db): Promise<void> {
  const done = await db.setting.findUnique({ where: { key: FLAG } });
  if (done) return;
  await db.$transaction([
    db.trustedDomain.createMany({
      data: DEFAULT_TRUSTED_DOMAINS.map((domain) => ({ domain })),
      skipDuplicates: true,
    }),
    db.paymentMethod.createMany({
      data: [
        { title: 'СБП', instructions: 'Реквизиты не заданы — укажи их через /methods', requiresReceipt: true, sortOrder: 1 },
        { title: 'Перевод на карту', instructions: 'Реквизиты не заданы — укажи их через /methods', requiresReceipt: true, sortOrder: 2 },
        { title: 'Наличные', instructions: 'Договоримся о встрече', requiresReceipt: false, sortOrder: 3 },
      ],
    }),
    db.setting.create({ data: { key: FLAG, value: true } }),
  ]);
}
