import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDb } from './db/client.js';
import { bootstrapDefaults } from './db/bootstrap.js';
import { UserService } from './services/user-service.js';
import { InviteService } from './services/invite-service.js';
import { SettingsService } from './services/settings-service.js';
import { TrustedDomainService } from './services/domain-service.js';
import { createBot } from './bot/index.js';
import { createHttpServer } from './http/server.js';
import type { Deps } from './bot/context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);
  const db = createDb(config.DATABASE_URL);
  await db.$connect();
  await bootstrapDefaults(db);

  const deps: Deps = {
    config,
    db,
    log,
    users: new UserService(db),
    invites: new InviteService(db),
    settings: new SettingsService(db),
    domains: new TrustedDomainService(db),
  };

  const bot = createBot(deps);
  const http = createHttpServer({ config, db, bot });
  await http.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
  log.info({ port: config.HTTP_PORT }, 'http server listening');

  await bot.init();
  await bot.api.setMyCommands([
    { command: 'start', description: 'Главное меню' },
    { command: 'help', description: 'Помощь' },
  ]);

  if (config.BOT_MODE === 'webhook') {
    await bot.api.setWebhook(config.WEBHOOK_URL!, {
      secret_token: config.WEBHOOK_SECRET!,
      allowed_updates: ['message', 'callback_query'],
    });
    log.info('webhook mode');
  } else {
    await bot.api.deleteWebhook();
    void bot.start({
      allowed_updates: ['message', 'callback_query'],
      onStart: () => log.info('long polling started'),
    });
  }

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    if (config.BOT_MODE === 'polling') await bot.stop();
    await http.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
