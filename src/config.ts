import { z } from 'zod';
import { makeKeyring, parseOldKeys } from './services/crypto.js';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const encryptionKey = z.string().transform((value, ctx) => {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ENCRYPTION_KEY must be 32 bytes in base64' });
    return z.NEVER;
  }
  return key;
});

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    BOT_TOKEN: z.string().min(20),
    ADMIN_TELEGRAM_ID: z.coerce.bigint().positive(),
    ADMIN_CHAT_ID: z.preprocess(emptyToUndefined, z.coerce.bigint().optional()),
    DATABASE_URL: z.string().min(1),
    BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
    WEBHOOK_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
    WEBHOOK_SECRET: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .min(16)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
    ),
    HTTP_HOST: z.string().default('0.0.0.0'),
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    ENCRYPTION_KEY: encryptionKey,
    /** Номер текущего ключа (1..255). При ротации увеличивается; старый ключ переносится в ENCRYPTION_KEYS_OLD. */
    ENCRYPTION_KEY_ID: z.coerce.number().int().min(1).max(255).default(1),
    /** Старые ключи для чтения ещё не перешифрованных данных: "1:<base64>,2:<base64>". */
    ENCRYPTION_KEYS_OLD: z.preprocess(emptyToUndefined, z.string().optional()),
    TIMEZONE: z.string().default('Europe/Moscow'),
    /** Публичный HTTPS-адрес Mini App (например https://bot.example.com/app/). Если пуст — Mini App отключён в боте. */
    WEBAPP_URL: z.preprocess(emptyToUndefined, z.string().url().startsWith('https://').optional()),
    /** Каталог со сборкой Mini App (по умолчанию webapp/dist относительно рабочей директории). */
    WEBAPP_DIST: z.string().default('webapp/dist'),
    /** Максимальный возраст initData, секунд. */
    WEBAPP_INITDATA_TTL_SEC: z.coerce.number().int().min(60).max(7 * 86_400).default(86_400),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.BOT_MODE === 'webhook') {
      if (!cfg.WEBHOOK_URL) ctx.addIssue({ code: 'custom', path: ['WEBHOOK_URL'], message: 'required in webhook mode' });
      if (!cfg.WEBHOOK_SECRET) ctx.addIssue({ code: 'custom', path: ['WEBHOOK_SECRET'], message: 'required in webhook mode' });
    }
  });

const withKeyring = schema.transform((cfg, ctx) => {
  try {
    return { ...cfg, keyring: makeKeyring(cfg.ENCRYPTION_KEY_ID, cfg.ENCRYPTION_KEY, parseOldKeys(cfg.ENCRYPTION_KEYS_OLD)) };
  } catch (e) {
    ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEYS_OLD'], message: (e as Error).message });
    return z.NEVER;
  }
});

export type Config = z.output<typeof withKeyring>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = withKeyring.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${problems}`);
  }
  return parsed.data;
}
