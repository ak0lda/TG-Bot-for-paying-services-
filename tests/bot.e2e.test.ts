import { randomBytes } from 'node:crypto';
import { Api } from 'grammy';
import type { Bot } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDeps } from '../src/app.js';
import { createBot } from '../src/bot/index.js';
import type { BotContext, Deps } from '../src/bot/context.js';
import { loadConfig } from '../src/config.js';
import { bootstrapDefaults } from '../src/db/bootstrap.js';
import { createDb, type Db } from '../src/db/client.js';
import { sumEntries } from '../src/domain/ledger.js';
import { createLogger } from '../src/logger.js';
import { decrypt } from '../src/services/crypto.js';

// Запуск: TEST_DATABASE_URL=postgresql://... pnpm test  (данные очищаются!)
const url = process.env.TEST_DATABASE_URL;
const ADMIN = 1000;
const CLIENT = 2000;
const STRANGER = 3000;

interface Sent {
  method: string;
  chat: number;
  text: string;
  payload: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe.skipIf(!url)('bot e2e (fake Telegram)', () => {
  let db: Db;
  let deps: Deps;
  let bot: Bot<BotContext>;
  let sent: Sent[] = [];
  let updateId = 1;
  let msgId = 100;
  let encKey: Buffer;

  const transformer = async (_prev: unknown, method: string, payload: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    sent.push({ method, chat: Number(payload.chat_id ?? 0), text: String(payload.text ?? payload.caption ?? ''), payload });
    const result =
      method.startsWith('send') || method.startsWith('edit')
        ? { message_id: ++msgId, date: 0, chat: { id: payload.chat_id ?? 0, type: 'private' }, text: payload.text }
        : true;
    return { ok: true, result } as never;
  };

  const from = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });

  async function say(id: number, text: string, extra: Record<string, unknown> = {}) {
    const entities = text.startsWith('/')
      ? [{ type: 'bot_command', offset: 0, length: (text.indexOf(' ') === -1 ? text.length : text.indexOf(' ')) }]
      : undefined;
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: msgId++, date: 0, chat: { id, type: 'private' }, from: from(id), text, ...(entities ? { entities } : {}), ...extra },
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
  const cbData = (s: Sent | undefined): string[] =>
    ((s?.payload.reply_markup?.inline_keyboard ?? []) as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data ?? '');

  beforeAll(async () => {
    encKey = randomBytes(32);
    const config = loadConfig({
      BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUV', ADMIN_TELEGRAM_ID: String(ADMIN), DATABASE_URL: url!,
      ENCRYPTION_KEY: encKey.toString('base64'), LOG_LEVEL: 'fatal',
    });
    db = createDb(url!);
    const api = new Api(config.BOT_TOKEN);
    api.config.use(transformer as never);
    deps = buildDeps(config, db, createLogger(config), api);
    bot = createBot(deps, { rateLimit: { capacity: 10_000, refillPerSec: 10_000 } });
    bot.api.config.use(transformer as never);
    bot.botInfo = {
      id: 1, is_bot: true, first_name: 'Bot', username: 'test_bot', can_join_groups: false,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
      has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
    } as never;
  });
  afterAll(async () => db.$disconnect());

  beforeEach(async () => {
    sent = [];
    await db.$executeRawUnsafe(
      'TRUNCATE "Attachment","LedgerEntry","OrderEvent","Order","TopUp","Invite","Setting","TrustedDomain","PaymentMethod","AdminCard","User" RESTART IDENTITY CASCADE',
    );
    await bootstrapDefaults(db);
    deps.wizards.cancel(ADMIN);
    deps.wizards.cancel(CLIENT);
  });

  async function onboard() {
    await say(ADMIN, '/start');
    await say(ADMIN, '/invite Вася');
    const code = /start=([\w-]+)/.exec(lastTo(ADMIN)!.text)![1]!;
    await say(CLIENT, `/start ${code}`);
    await say(ADMIN, '/card_add Visa ··4417 USD');
    await say(ADMIN, '/method_edit 1 | СБП, +7 900 000-00-00, Тест-банк');
    await say(ADMIN, '/rate USD 90');
  }

  async function createOrder(opts: { type?: string } = {}) {
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, `w:type:${opts.type ?? 'PAYMENT_LINK'}`);
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, 'Netflix');
    await say(CLIENT, 'Premium');
    await say(CLIENT, '10 USD');
    await click(CLIENT, 'w:period:ONE');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
  }

  it('refuses strangers politely and blocks admin-only commands for clients', async () => {
    await say(STRANGER, 'привет');
    expect(lastTo(STRANGER)!.text).toMatch(/закрытый бот/i);
    await say(STRANGER, '/start');
    expect(lastTo(STRANGER)!.text).toMatch(/закрытый бот/i);
    await say(STRANGER, '/start badcode123');
    expect(lastTo(STRANGER)!.text).toMatch(/недействителен/i);

    await onboard();
    expect(await db.user.count({ where: { role: 'CLIENT' } })).toBe(1);
    expect(allTo(ADMIN)).toMatch(/Новый клиент/);
    await say(CLIENT, '/invite');
    expect(lastTo(CLIENT)!.text).toMatch(/только администратору/);
    await say(CLIENT, 'просто текст');
    expect(lastTo(CLIENT)!.text).toMatch(/Не понял/); // клиентские апдейты не перехватываются админским guard'ом
  });

  it('full PREPAY lifecycle with idempotent buttons, ledger and settlement', async () => {
    await onboard();
    await createOrder();

    let order = await db.order.findFirstOrThrow();
    expect(order).toMatchObject({ status: 'NEW', service: 'Netflix', amountMinor: 1000n, currency: 'USD', urlDomain: 'checkout.stripe.com' });
    const card = lastTo(ADMIN)!;
    expect(card.text).toMatch(/Доверенный домен/);
    expect(cbData(card)).toContain(`o:${order.id}:1:q`);

    // расчёт; повторный клик по той же кнопке — «устарела», не второй переход
    await click(ADMIN, `o:${order.id}:1:q`);
    await click(ADMIN, `o:${order.id}:1:q`);
    order = await db.order.findFirstOrThrow();
    expect(order).toMatchObject({ status: 'QUOTED', version: 2, totalMinor: 96_400n }); // 10×90×1.02×1.05=963,90 → 964 ₽
    expect(await db.orderEvent.count({ where: { toStatus: 'QUOTED' } })).toBe(1);
    expect(sent.some((x) => x.method === 'answerCallbackQuery' && /Карточка устарела/.test(x.text))).toBe(true);

    // клиент подтверждает, выбирает метод
    expect(allTo(CLIENT)).toMatch(/964 ₽/);
    await click(CLIENT, `o:${order.id}:2:cf`);
    await click(CLIENT, 'w:method:1');
    order = await db.order.findFirstOrThrow();
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(lastTo(CLIENT)!.text).toMatch(/Тест-банк/);

    // «Я оплатил» + чек
    await click(CLIENT, `o:${order.id}:3:pd`);
    await say(CLIENT, 'сейчас пришлю'); // текст вместо файла — ошибка, шаг остаётся
    expect(lastTo(CLIENT)!.text).toMatch(/фото или файл/);
    await photo(CLIENT);
    order = await db.order.findFirstOrThrow();
    expect(order.status).toBe('PAYMENT_CHECK');
    expect(sent.some((s) => s.method === 'sendPhoto' && s.chat === ADMIN)).toBe(true);
    expect(await db.attachment.count()).toBe(1);

    // админ подтверждает оплату -> ledger +total
    await click(ADMIN, `o:${order.id}:4:pc`);
    order = await db.order.findFirstOrThrow();
    expect(order.status).toBe('IN_PROGRESS');
    const adminCard = [...sent].reverse().find((s) => s.chat === ADMIN && cbData(s).some((d) => d.endsWith(':dn')));
    expect(adminCard).toBeTruthy();
    expect(JSON.stringify(adminCard!.payload.reply_markup)).toContain('https://checkout.stripe.com');

    // «Выполнено»: карта, факт 10,50 USD по курсу 90 -> 945 ₽ против оценки 918 ₽ => доплата 27 ₽
    await click(ADMIN, `o:${order.id}:5:dn`);
    await click(ADMIN, 'w:card:1');
    await say(ADMIN, '10,50');
    await click(ADMIN, 'w:rate:ok');
    await click(ADMIN, 'w:shot:skip');
    expect(lastTo(ADMIN)!.text).toMatch(/Разница: <b>−27 ₽<\/b>/);
    await click(ADMIN, 'w:confirm:ok');

    order = await db.order.findFirstOrThrow();
    expect(order).toMatchObject({ status: 'DONE', diffMinor: -2700n, actualChargeMinor: 1050n, actualCurrency: 'USD' });
    const ledger = await db.ledgerEntry.findMany({ orderBy: { id: 'asc' } });
    expect(ledger.map((l) => [l.type, l.amountMinor])).toEqual([
      ['PAYMENT_RECEIVED', 96_400n], ['ORDER_CHARGE', -96_400n], ['DIFF_ADJUST', -2_700n],
    ]);
    expect(sumEntries(ledger)).toBe(-2_700n);
    expect(allTo(CLIENT)).toMatch(/выполнена/);
    expect(allTo(CLIENT)).toMatch(/Доплата/);

    const events = await db.orderEvent.findMany({ orderBy: { id: 'asc' } });
    expect(events.map((e) => e.toStatus)).toEqual(['NEW', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_CHECK', 'IN_PROGRESS', 'DONE']);

    // старая кнопка после DONE ничего не ломает
    await click(ADMIN, `o:${order.id}:5:dn`);
    expect((await db.order.findFirstOrThrow()).status).toBe('DONE');
    expect(await db.ledgerEntry.count()).toBe(3);
  });

  it('gift card: code is encrypted in DB and delivered to the client', async () => {
    await onboard();
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:GIFT_CARD');
    await say(CLIENT, 'Steam');
    await say(CLIENT, 'TR');
    await say(CLIENT, '25 USD');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    let order = await db.order.findFirstOrThrow();
    expect(order).toMatchObject({ type: 'GIFT_CARD', giftStore: 'Steam', giftRegion: 'TR', url: null });

    await click(ADMIN, `o:${order.id}:1:q`);
    await click(CLIENT, `o:${order.id}:2:cf`);
    await click(CLIENT, 'w:method:3'); // «Наличные» — чек не нужен
    await click(CLIENT, `o:${order.id}:3:pd`);
    order = await db.order.findFirstOrThrow();
    expect(order.status).toBe('PAYMENT_CHECK');
    await click(ADMIN, `o:${order.id}:4:pc`);

    await click(ADMIN, `o:${order.id}:5:dn`);
    await say(ADMIN, 'ABCD-EFGH-1234');
    await click(ADMIN, 'w:card:1');
    await say(ADMIN, '25');
    await click(ADMIN, 'w:rate:ok');
    await click(ADMIN, 'w:shot:skip');
    await click(ADMIN, 'w:confirm:ok');

    order = await db.order.findFirstOrThrow();
    expect(order.status).toBe('DONE');
    expect(order.giftCodeEnc).not.toBeNull();
    expect(Buffer.from(order.giftCodeEnc!).includes(Buffer.from('ABCD'))).toBe(false);
    expect(decrypt(order.giftCodeEnc!, encKey)).toBe('ABCD-EFGH-1234');
    expect(order.giftCodeDeleteAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(allTo(CLIENT)).toMatch(/ABCD-EFGH-1234/);
    expect(sent.some((s) => s.method === 'deleteMessage')).toBe(true); // код удалён из чата админа
  });

  it('rejects unsafe input: shortener, secrets in free text; warns about unknown domain', async () => {
    await onboard();
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://bit.ly/abc');
    expect(lastTo(CLIENT)!.text).toMatch(/Сокращённые ссылки/);
    await say(CLIENT, 'http://shop.example.com/pay');
    expect(lastTo(CLIENT)!.text).toMatch(/только https/);
    await say(CLIENT, 'https://evil-pay.example.org/checkout');
    await say(CLIENT, 'Hosting');
    await say(CLIENT, 'логин: ivan пароль: Qwerty123');
    expect(lastTo(CLIENT)!.text).toMatch(/не принимаю и не сохраняю/);
    await say(CLIENT, 'моя карта 4242 4242 4242 4242');
    expect(lastTo(CLIENT)!.text).toMatch(/не принимаю и не сохраняю/);
    await say(CLIENT, 'VPS 2 GB');
    await say(CLIENT, '5 USD');
    await click(CLIENT, 'w:period:MONTH');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');

    const order = await db.order.findFirstOrThrow();
    expect(order).toMatchObject({ isSubscription: true, periodKind: 'MONTH', description: 'VPS 2 GB' });
    expect(JSON.stringify(order, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/Qwerty|4242/);
    expect(lastTo(ADMIN)!.text).toMatch(/НЕИЗВЕСТНЫЙ ДОМЕН/);
  });

  it('client cannot act on foreign orders or admin actions; reject keeps paid money on balance', async () => {
    await onboard();
    await createOrder();
    const order = await db.order.findFirstOrThrow();
    await click(CLIENT, `o:${order.id}:1:q`); // админское действие
    expect((await db.order.findFirstOrThrow()).status).toBe('NEW');

    await click(ADMIN, `o:${order.id}:1:q`);
    await click(CLIENT, `o:${order.id}:2:cf`);
    await click(CLIENT, 'w:method:1');
    await click(CLIENT, `o:${order.id}:3:pd`);
    await photo(CLIENT);
    await click(ADMIN, `o:${order.id}:4:pc`);

    // клиент уже не может отменить после подтверждения оплаты
    await click(CLIENT, `o:${order.id}:5:cx`);
    expect((await db.order.findFirstOrThrow()).status).toBe('IN_PROGRESS');

    await click(ADMIN, `o:${order.id}:5:rj`);
    await say(ADMIN, 'Сервис недоступен в регионе');
    const done = await db.order.findFirstOrThrow();
    expect(done).toMatchObject({ status: 'REJECTED', rejectReason: 'Сервис недоступен в регионе' });
    expect(sumEntries(await db.ledgerEntry.findMany())).toBe(96_400n); // деньги остаются на балансе
    expect(allTo(CLIENT)).toMatch(/осталась на твоём балансе/);
  });

  it('expired quote -> EXPIRED -> recalculate; link-invalid loop', async () => {
    await onboard();
    await createOrder();
    const id = (await db.order.findFirstOrThrow()).id;
    await click(ADMIN, `o:${id}:1:q`);
    await db.order.update({ where: { id }, data: { quoteExpiresAt: new Date(Date.now() - 1000) } });

    const expired = await deps.orders.expireDue();
    expect(expired).toHaveLength(1);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
    const v = (await db.order.findUniqueOrThrow({ where: { id } })).version;
    await click(CLIENT, `o:${id}:${v}:rq`);
    expect((await db.order.findUniqueOrThrow({ where: { id } }))).toMatchObject({ status: 'QUOTED' });

    // оплата -> в работе -> ссылка не работает -> новая ссылка
    let ver = (await db.order.findUniqueOrThrow({ where: { id } })).version;
    await click(CLIENT, `o:${id}:${ver}:cf`);
    await click(CLIENT, 'w:method:3');
    ver = (await db.order.findUniqueOrThrow({ where: { id } })).version;
    await click(CLIENT, `o:${id}:${ver}:pd`);
    ver = (await db.order.findUniqueOrThrow({ where: { id } })).version;
    await click(ADMIN, `o:${id}:${ver}:pc`);
    ver = (await db.order.findUniqueOrThrow({ where: { id } })).version;
    await click(ADMIN, `o:${id}:${ver}:lk`);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('LINK_INVALID');
    expect(allTo(CLIENT)).toMatch(/Ссылка по заявке/);

    ver = (await db.order.findUniqueOrThrow({ where: { id } })).version;
    await click(CLIENT, `o:${id}:${ver}:nl`);
    await say(CLIENT, 'https://pay.paddle.com/checkout/new-link');
    const after = await db.order.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: 'IN_PROGRESS', urlDomain: 'pay.paddle.com' });
    expect(await db.ledgerEntry.count()).toBe(1); // оплата клиента сохранена
  });

  it('expired quote cannot be confirmed by the client', async () => {
    await onboard();
    await createOrder();
    const id = (await db.order.findFirstOrThrow()).id;
    await click(ADMIN, `o:${id}:1:q`);
    await db.order.update({ where: { id }, data: { quoteExpiresAt: new Date(Date.now() - 1000) } });
    await click(CLIENT, `o:${id}:2:cf`);
    await click(CLIENT, 'w:method:1');
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
    expect(allTo(CLIENT)).toMatch(/Расчёт истёк/);
  });
});
