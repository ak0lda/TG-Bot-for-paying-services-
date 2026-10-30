/**
 * Печатает ссылку для открытия Mini App в обычном браузере с подписанным initData (для локальной отладки).
 * Сервер проверяет подпись по BOT_TOKEN из .env, поэтому ссылка работает только для пользователей, которые у вас есть в БД
 * (админ — ADMIN_TELEGRAM_ID). Ссылка действует WEBAPP_INITDATA_TTL_SEC (по умолчанию 24 ч).
 *
 *   pnpm webapp:link <telegramId> [http://localhost:5173/app/]
 *
 * ВАЖНО: ссылка даёт доступ к аккаунту — не публикуйте её. Вне Telegram SDK требует эмулировать среду, поэтому в
 * обычном браузере откроется страница с подсказкой; для полной проверки используйте scripts/webapp-smoke.ts.
 */
import { loadConfig } from '../src/config.js';
import { buildSignedInitData } from '../src/http/api/webapp-auth.js';

const id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id <= 0) {
  console.error('Использование: pnpm webapp:link <telegramId> [baseUrl]');
  process.exit(1);
}
const cfg = loadConfig();
const base = process.argv[3] ?? cfg.WEBAPP_URL ?? 'http://localhost:3000/app/';
const initData = buildSignedInitData({ id, first_name: 'Debug' }, cfg.BOT_TOKEN);
console.log(
  `${base}#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0&tgWebAppPlatform=web&tgWebAppThemeParams=%7B%7D`,
);
