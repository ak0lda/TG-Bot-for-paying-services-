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
        // Реквизиты админ присылает вручную при каждой заявке (в базе не хранятся); instructions — необязательный готовый текст.
        { title: 'СБП', instructions: '', requiresReceipt: true, sortOrder: 1 },
        { title: 'Прямой перевод', instructions: '', requiresReceipt: true, sortOrder: 2 },
        { title: 'Наличные', instructions: '', requiresReceipt: false, sortOrder: 3 },
      ],
    }),
    db.setting.create({ data: { key: FLAG, value: true } }),
  ]);
}
