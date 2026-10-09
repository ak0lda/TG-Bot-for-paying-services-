import { randomBytes } from 'node:crypto';
import { Api } from 'grammy';
import type { Bot } from 'grammy';
import { buildDeps } from '../../src/app.js';
import { createBot } from '../../src/bot/index.js';
import type { BotContext, Deps } from '../../src/bot/context.js';
import { loadConfig } from '../../src/config.js';
import { bootstrapDefaults } from '../../src/db/bootstrap.js';
import { createDb, type Db } from '../../src/db/client.js';
import { createLogger } from '../../src/logger.js';

export const ADMIN = 1000;
export const CLIENT = 2000;
export const STRANGER = 3000;

export interface Sent {
  method: string;
  chat: number;
  text: string;
  payload: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Бот целиком (grammY + сервисы + реальная БД) с подставным Telegram API, который записывает вызовы. */
export const BOT_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUV';

export function createHarness(url: string, extraEnv: Record<string, string> = {}) {
  const encKey = randomBytes(32);
  const sent: Sent[] = [];
  let updateId = 1;
  let msgId = 100;

  const transformer = async (_prev: unknown, method: string, payload: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    sent.push({ method, chat: Number(payload.chat_id ?? 0), text: String(payload.text ?? payload.caption ?? ''), payload });
    const result =
      method.startsWith('send') || method.startsWith('edit')
        ? { message_id: ++msgId, date: 0, chat: { id: payload.chat_id ?? 0, type: 'private' }, text: payload.text }
        : true;
    return { ok: true, result } as never;
  };

  const config = loadConfig({
    BOT_TOKEN, ADMIN_TELEGRAM_ID: String(ADMIN), DATABASE_URL: url,
    ENCRYPTION_KEY: encKey.toString('base64'), LOG_LEVEL: 'fatal', ...extraEnv,
  });
  const db: Db = createDb(url);
  const api = new Api(config.BOT_TOKEN);
  api.config.use(transformer as never);
  const deps: Deps = buildDeps(config, db, createLogger(config), api);
  const bot: Bot<BotContext> = createBot(deps, { rateLimit: { capacity: 10_000, refillPerSec: 10_000 } });
  bot.api.config.use(transformer as never);
  bot.botInfo = {
    id: 1, is_bot: true, first_name: 'Bot', username: 'test_bot', can_join_groups: false,
    can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
    has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
  } as never;

  const from = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });

  async function say(id: number, text: string) {
    const entities = text.startsWith('/')
      ? [{ type: 'bot_command', offset: 0, length: text.indexOf(' ') === -1 ? text.length : text.indexOf(' ') }]
      : undefined;
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: msgId++, date: 0, chat: { id, type: 'private' }, from: from(id), text, ...(entities ? { entities } : {}) },
    } as never);
  }
  async function photo(id: number) {
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: msgId++, date: 0, chat: { id, type: 'private' }, from: from(id), photo: [{ file_id: 'PH1', file_unique_id: 'u', width: 1, height: 1 }] },
    } as never);
  }
  async function click(id: number, data: string) {
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId), from: from(id), chat_instance: 'ci', data,
        message: { message_id: msgId++, date: 0, chat: { id, type: 'private' }, text: 'x' },
      },
    } as never);
  }

  const lastTo = (chat: number) => [...sent].reverse().find((s) => s.chat === chat && s.method === 'sendMessage');
  const allTo = (chat: number) => sent.filter((s) => s.chat === chat).map((s) => s.text).join('\n---\n');
  const alerts = () => sent.filter((s) => s.method === 'answerCallbackQuery').map((s) => s.text);
  const cbData = (s: Sent | undefined): string[] =>
    ((s?.payload.reply_markup?.inline_keyboard ?? []) as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data ?? '');

  async function reset() {
    sent.length = 0;
    await db.$executeRawUnsafe(
      'TRUNCATE "Attachment","LedgerEntry","OrderEvent","Order","TopUp","Invite","Setting","TrustedDomain","PaymentMethod","AdminCard","Reminder","User" RESTART IDENTITY CASCADE',
    );
    await bootstrapDefaults(db);
    deps.wizards.cancel(ADMIN);
    deps.wizards.cancel(CLIENT);
  }

  /** Админ + один клиент, карта Visa ··4417 (USD), метод «СБП» с реквизитами, ручной курс USD = 90. */
  async function onboard() {
    await say(ADMIN, '/start');
    await say(ADMIN, '/invite Вася');
    const code = /start=([\w-]+)/.exec(lastTo(ADMIN)!.text)![1]!;
    await say(CLIENT, `/start ${code}`);
    await say(ADMIN, '/card_add Visa ··4417 USD');
    await say(ADMIN, '/rate USD 90');
    return db.user.findFirstOrThrow({ where: { role: 'CLIENT' } });
  }

  /** Админ выбирает способ для заявки и присылает реквизиты (как в боте: кнопка способа -> текст). */
  async function requisites(orderId: number, methodId: number, text = 'Реквизиты: тестовый перевод') {
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    await click(ADMIN, `r:${orderId}:${o.version}:${methodId}`);
    await say(ADMIN, text);
  }

  const orderVersion = async (id: number) => (await db.order.findUniqueOrThrow({ where: { id } })).version;

  return { db, deps, bot, sent, encKey, say, photo, click, lastTo, allTo, alerts, cbData, reset, onboard, orderVersion, requisites };
}
