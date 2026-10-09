import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { webhookCallback, type Bot } from 'grammy';
import type { BotContext, Deps } from '../bot/context.js';
import { registerApi } from './api/index.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  // Встраивать приложение могут только клиенты Telegram (защита от clickjacking).
  "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org",
].join('; ');

export async function createHttpServer(opts: { deps: Deps; bot: Bot<BotContext> }): Promise<FastifyInstance> {
  const { deps, bot } = opts;
  const { config, db } = deps;
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  app.get('/health', async (_req, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  if (config.BOT_MODE === 'webhook') {
    // grammY сам сверяет заголовок X-Telegram-Bot-Api-Secret-Token.
    app.post('/webhook', webhookCallback(bot, 'fastify', { secretToken: config.WEBHOOK_SECRET! }));
  }

  await registerApi(app, deps);

  // Статика Mini App (сборка webapp/dist). Если сборки нет, приложение просто не раздаётся.
  const dist = resolve(config.WEBAPP_DIST);
  if (existsSync(resolve(dist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: '/app/',
      redirect: true,
      setHeaders: (res, path) => {
        res.header('Content-Security-Policy', CSP);
        res.header('X-Content-Type-Options', 'nosniff');
        res.header('Referrer-Policy', 'no-referrer');
        // Файлы с хешем в имени кешируем навсегда, index.html — никогда (иначе после деплоя останется старая версия).
        res.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
      },
    });
    deps.log.info({ dist }, 'mini app static enabled');
  }

  return app;
}
