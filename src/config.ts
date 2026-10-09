import { z } from 'zod';

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
    TIMEZONE: z.string().default('Europe/Moscow'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.BOT_MODE === 'webhook') {
      if (!cfg.WEBHOOK_URL) ctx.addIssue({ code: 'custom', path: ['WEBHOOK_URL'], message: 'required in webhook mode' });
      if (!cfg.WEBHOOK_SECRET) ctx.addIssue({ code: 'custom', path: ['WEBHOOK_SECRET'], message: 'required in webhook mode' });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${problems}`);
  }
  return parsed.data;
}
