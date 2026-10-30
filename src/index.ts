import { loadConfig } from './config.js';
import { mask } from './logging/safe-error.js';
import { createLogger } from './logger.js';
import { createDb } from './db/client.js';
import { bootstrapDefaults } from './db/bootstrap.js';
import { Api } from 'grammy';
import { startScheduler } from './services/scheduler.js';
import { buildDeps } from './app.js';
import { createBot } from './bot/index.js';
import { createHttpServer } from './http/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);
  const db = createDb(config.DATABASE_URL);
  await db.$connect();
  await bootstrapDefaults(db);

  const deps = buildDeps(config, db, log, new Api(config.BOT_TOKEN));

  const bot = createBot(deps);
  const http = await createHttpServer({ deps, bot });
  await http.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
  log.info({ port: config.HTTP_PORT }, 'http server listening');

  await bot.init();
  const stopScheduler = startScheduler(deps);
  await bot.api.setMyCommands([
    { command: 'start', description: 'Главное меню' },
    { command: 'help', description: 'Помощь' },
    { command: 'cancel', description: 'Отменить текущий диалог' },
    ...(config.WEBAPP_URL ? [{ command: 'app', description: 'Открыть приложение' }] : []),
  ]);

  if (config.WEBAPP_URL) {
    // Кнопка меню чата открывает Mini App (для всех чатов по умолчанию).
    await bot.api.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Приложение', web_app: { url: config.WEBAPP_URL } },
    });
    log.info('mini app menu button set');
  }

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
    stopScheduler();
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
  console.error(e instanceof Error ? mask(e.message) : 'startup failed');
  process.exit(1);
});
