/**
 * Ротация ключа шифрования кодов подарочных карт.
 *
 * 1. Сгенерируйте новый ключ:           openssl rand -base64 32
 * 2. В .env: старый ключ -> ENCRYPTION_KEYS_OLD="<старый id>:<старый base64>",
 *            новый ключ  -> ENCRYPTION_KEY=<новый base64>, ENCRYPTION_KEY_ID=<старый id + 1>
 * 3. Проверьте:   pnpm keys:rotate --dry-run
 * 4. Выполните:   pnpm keys:rotate
 * 5. Когда отчёт «осталось со старым ключом: 0» — старый ключ можно убрать из ENCRYPTION_KEYS_OLD
 *    (но храните его, пока живы бэкапы БД со старым шифртекстом!).
 */
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { rotateGiftCodes } from '../src/services/key-rotation.js';

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
const dryRun = process.argv.includes('--dry-run');
try {
  const r = await rotateGiftCodes(db, cfg.keyring, { dryRun });
  console.log(
    `${dryRun ? '[dry-run] ' : ''}всего кодов: ${r.total}, уже текущим ключом: ${r.alreadyCurrent}, ${dryRun ? 'будет перешифровано' : 'перешифровано'}: ${r.rotated}`,
  );
  console.log(`осталось со старым ключом: ${dryRun ? r.rotated : r.failed.length}`);
  if (r.failed.length) {
    console.error(
      `НЕ удалось расшифровать заявки: ${r.failed.join(', ')} — нет подходящего старого ключа в ENCRYPTION_KEYS_OLD или данные повреждены`,
    );
    process.exitCode = 1;
  }
} finally {
  await db.$disconnect();
}
