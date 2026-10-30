import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TgWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export type InitDataFailure = 'missing' | 'no_hash' | 'bad_hash' | 'expired' | 'future' | 'no_user';

export type InitDataResult = { ok: true; user: TgWebAppUser; authDate: Date } | { ok: false; reason: InitDataFailure };

const MAX_FUTURE_SKEW_SEC = 300;

/**
 * Проверка Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN); hash = HMAC_SHA256(key=secret, msg=data_check_string),
 * где data_check_string — все поля кроме `hash`, отсортированные по ключу, `key=value` через «\n».
 * Дополнительно: ограничение по возрасту auth_date (защита от повторного использования старой подписи).
 */
export function validateInitData(
  raw: string,
  botToken: string,
  now: Date = new Date(),
  maxAgeSec = 86_400,
): InitDataResult {
  if (!raw || raw.length > 8_192) return { ok: false, reason: 'missing' };
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'no_hash' };
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_hash' };

  const authSec = Number(params.get('auth_date'));
  if (!Number.isInteger(authSec) || authSec <= 0) return { ok: false, reason: 'expired' };
  const nowSec = Math.floor(now.getTime() / 1000);
  if (authSec - nowSec > MAX_FUTURE_SKEW_SEC) return { ok: false, reason: 'future' };
  if (nowSec - authSec > maxAgeSec) return { ok: false, reason: 'expired' };

  try {
    const user = JSON.parse(params.get('user') ?? '') as TgWebAppUser;
    if (!Number.isSafeInteger(user?.id) || user.id <= 0 || typeof user.first_name !== 'string')
      throw new Error('bad user');
    return { ok: true, user, authDate: new Date(authSec * 1000) };
  } catch {
    return { ok: false, reason: 'no_user' };
  }
}

/** Подписывает initData так же, как это делает Telegram (для тестов и локальной отладки). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

export function buildSignedInitData(user: TgWebAppUser, botToken: string, now: Date = new Date()): string {
  return signInitData(
    {
      auth_date: String(Math.floor(now.getTime() / 1000)),
      query_id: 'AAHdebug',
      user: JSON.stringify(user),
      // Реальный Telegram добавляет Ed25519-подпись для сторонней проверки; сервер её не использует (хватает HMAC),
      // но клиентский SDK требует поле, поэтому в отладочных данных оно есть.
      signature: 'debug-signature',
    },
    botToken,
  );
}
