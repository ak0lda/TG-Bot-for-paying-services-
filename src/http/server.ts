import Fastify, { type FastifyInstance } from 'fastify';
import { webhookCallback, type Bot } from 'grammy';
import type { BotContext } from '../bot/context.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';

export function createHttpServer(opts: { config: Config; db: Db; bot: Bot<BotContext> }): FastifyInstance {
  const { config, db, bot } = opts;
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

  return app;
}
