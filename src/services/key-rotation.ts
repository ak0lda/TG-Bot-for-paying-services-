import type { Db } from '../db/client.js';
import { decrypt, encrypt, needsRotation, type Keyring } from './crypto.js';

export interface RotationReport {
  total: number;
  alreadyCurrent: number;
  rotated: number;
  /** id заявок, которые не удалось расшифровать (нет старого ключа или данные повреждены) — они не изменены. */
  failed: number[];
}

/**
 * Перешифровывает коды подарочных карт текущим ключом. Идемпотентно; повреждённые записи не трогает.
 * dryRun — только посчитать. Каждая запись обновляется условно (по старому шифртексту), чтобы не затереть параллельное изменение.
 */
export async function rotateGiftCodes(db: Db, ring: Keyring, opts: { dryRun?: boolean } = {}): Promise<RotationReport> {
  const rows = await db.order.findMany({
    where: { giftCodeEnc: { not: null } },
    select: { id: true, giftCodeEnc: true },
  });
  const report: RotationReport = { total: rows.length, alreadyCurrent: 0, rotated: 0, failed: [] };
  for (const row of rows) {
    const enc = row.giftCodeEnc!;
    if (!needsRotation(enc, ring)) {
      report.alreadyCurrent++;
      continue;
    }
    let plain: string;
    try {
      plain = decrypt(enc, ring);
    } catch {
      report.failed.push(row.id);
      continue;
    }
    if (opts.dryRun) {
      report.rotated++;
      continue;
    }
    const res = await db.order.updateMany({
      where: { id: row.id, giftCodeEnc: new Uint8Array(enc) },
      data: { giftCodeEnc: new Uint8Array(encrypt(plain, ring)) },
    });
    if (res.count === 1) report.rotated++;
  }
  return report;
}
