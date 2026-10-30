import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { buildSignedInitData } from '../src/http/api/webapp-auth.js';
import { ADMIN, BOT_TOKEN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('automatic requisites by amount', () => {
  const h = url ? createHarness(url) : (undefined as never);
  const { db, say, photo, click, lastTo, allTo, alerts, onboard, orderVersion, requisites } = h ?? ({} as typeof h);
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createHttpServer({ deps: h.deps, bot: h.bot });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });
  beforeEach(() => h.reset());

  /** СБП до 5 799,99 ₽ и прямой перевод от 5 800 до 640 000 ₽ — оба с автоотправкой. */
  async function setupMethods() {
    await onboard();
    await say(ADMIN, '/method_edit 1 | СБП: +7 900 111-22-33, Тест-банк, ИВАН И.');
    await say(ADMIN, '/method_limits 1 - 5799.99');
    await say(ADMIN, '/method_auto 1 on');
    await say(ADMIN, '/method_edit 2 | Прямой перевод: +995 555 00 00 00, Example Bank, IVAN IVANOV');
    await say(ADMIN, '/method_limits 2 5800 640000');
    await say(ADMIN, '/method_auto 2 on');
  }

  async function orderFor(amountUsd: string) {
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, 'Netflix');
    await say(CLIENT, 'Premium');
    await say(CLIENT, `${amountUsd} USD`);
    await click(CLIENT, 'w:period:ONE');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    const o = await db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
    await click(ADMIN, `o:${o.id}:1:q`);
    h.sent.length = 0;
    await click(CLIENT, `o:${o.id}:2:cf`);
    return db.order.findUniqueOrThrow({ where: { id: o.id } });
  }

  it('configuration commands: limits, auto switch, listing, validation', async () => {
    await setupMethods();
    await say(ADMIN, '/methods');
    const list = lastTo(ADMIN)!.text;
    expect(list).toMatch(/сумма до 5 799,99 ₽; 🤖 автоотправка: вкл/);
    expect(list).toMatch(/сумма от 5 800 ₽ до 640 000 ₽; 🤖 автоотправка: вкл/);
    expect(list).toMatch(/Текст реквизитов: Прямой перевод: \+995 555 00 00 00, Example Bank/);
    expect(list).toMatch(/автоотправка: выкл/); // «Наличные»

    for (const [cmd, re] of [
      ['/method_limits 1 100 50', /не удалось разобрать/i],
      ['/method_limits 1 abc 50', /не удалось разобрать/i],
      ['/method_limits 1 100', /Использование/],
      ['/method_limits 99 1 2', /не найден/i],
      ['/method_auto 3 on', /Сначала задай текст/],
      ['/method_auto 1 maybe', /Использование/],
      ['/method_edit 3 | 4242 4242 4242 4242', /номер банковской карты/],
    ] as const) {
      await say(ADMIN, cmd);
      expect(lastTo(ADMIN)!.text, cmd).toMatch(re);
    }
    await say(ADMIN, '/method_limits 1 off');
    expect(await db.paymentMethod.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      minAmountMinor: null,
      maxAmountMinor: null,
    });
    await say(CLIENT, '/method_auto 1 off');
    expect((await db.paymentMethod.findUniqueOrThrow({ where: { id: 1 } })).autoSend).toBe(true); // клиент не может
    expect(lastTo(CLIENT)!.text).toMatch(/только администратору/);
  });

  it('order: the method that fits the amount is chosen and requisites arrive without admin involvement', async () => {
    await setupMethods();

    const small = await orderFor('10'); // 964 ₽ -> СБП
    expect(small).toMatchObject({ status: 'AWAITING_PAYMENT', payMethodId: 1 });
    const toClient = allTo(CLIENT);
    expect(toClient).toMatch(/СБП: \+7 900 111-22-33, Тест-банк/);
    expect(toClient).toMatch(/К оплате: <b>964 ₽<\/b>/);
    expect(toClient).not.toMatch(/Админ пришлёт реквизиты/);
    expect(h.cbData(lastTo(CLIENT))).toEqual([`o:${small.id}:3:pd`, `o:${small.id}:3:cx`]);
    expect(allTo(ADMIN)).toMatch(/отправлены клиенту автоматически/);
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: small.id }, orderBy: { id: 'desc' } });
    expect(ev).toMatchObject({
      comment: 'Реквизиты отправлены автоматически: СБП',
      actorId: null,
      toStatus: 'AWAITING_PAYMENT',
    });

    // дальше обычный путь: клиент оплатил -> админ подтвердил
    await click(CLIENT, `o:${small.id}:3:pd`);
    await photo(CLIENT);
    expect((await db.order.findUniqueOrThrow({ where: { id: small.id } })).status).toBe('PAYMENT_CHECK');

    const big = await orderFor('70'); // 6 748 ₽ -> прямой перевод (минимум 5 800)
    expect(big).toMatchObject({ payMethodId: 2, payDueMinor: 674_800n });
    expect(allTo(CLIENT)).toMatch(/Example Bank, IVAN IVANOV/);
    expect(allTo(CLIENT)).not.toMatch(/Тест-банк/);
  });

  it('falls back to the manual flow when nothing fits (and tells the admin why); admin can still override', async () => {
    await setupMethods();
    const huge = await orderFor('8000'); // 771 120 ₽ > 640 000 ₽
    expect(huge).toMatchObject({ status: 'AWAITING_PAYMENT', payMethodId: null });
    expect(allTo(CLIENT)).toMatch(/Админ пришлёт реквизиты/);
    expect(allTo(ADMIN)).toMatch(/не подходит ни под один способ с автоотправкой/);
    await requisites(huge.id, 2, 'Индивидуально: частями');
    expect((await db.order.findUniqueOrThrow({ where: { id: huge.id } })).payMethodId).toBe(2);

    // автоспособ выключили — по маленькой сумме тоже ручной путь
    await say(ADMIN, '/method_toggle 1');
    const small = await orderFor('10');
    expect(small.payMethodId).toBeNull();
    expect(allTo(ADMIN)).toMatch(/не подходит ни под один способ/);
  });

  it('no auto methods configured: behaves exactly like before (admin sends requisites)', async () => {
    await onboard();
    const o = await orderFor('10');
    expect(o.payMethodId).toBeNull();
    expect(allTo(ADMIN)).toMatch(/выбери способ и отправь реквизиты/);
    expect(allTo(ADMIN)).not.toMatch(/не подходит ни под один способ/);
  });

  it('top-up: requisites chosen by amount, receipt flow continues, no match -> manual', async () => {
    await setupMethods();

    await say(CLIENT, '➕ Пополнить баланс');
    await say(CLIENT, '6000');
    const t = await db.topUp.findFirstOrThrow({ orderBy: { id: 'desc' } });
    expect(t.methodId).toBe(2);
    expect(allTo(CLIENT)).toMatch(/Example Bank, IVAN IVANOV/);
    expect(h.cbData(lastTo(CLIENT))).toEqual([`b:rc:${t.id}`]);
    expect(allTo(ADMIN)).toMatch(/отправлены клиенту автоматически/);
    await click(CLIENT, `b:rc:${t.id}`);
    await photo(CLIENT);
    await click(ADMIN, `t:${t.id}:ok`);
    expect(await db.ledgerEntry.count()).toBe(1);

    await say(CLIENT, '➕ Пополнить баланс');
    await say(CLIENT, '1000');
    expect((await db.topUp.findFirstOrThrow({ orderBy: { id: 'desc' } })).methodId).toBe(1);

    h.sent.length = 0;
    await say(CLIENT, '➕ Пополнить баланс');
    await say(CLIENT, '700000'); // больше 640 000 ₽
    expect((await db.topUp.findFirstOrThrow({ orderBy: { id: 'desc' } })).methodId).toBeNull();
    expect(allTo(CLIENT)).toMatch(/пришлёт реквизиты/);
    expect(allTo(ADMIN)).toMatch(/не подходит ни под один способ/);
    void alerts;
  });

  it('Mini App API confirm uses the same automatic selection', async () => {
    await setupMethods();
    const authFor = (id: number) => `tma ${buildSignedInitData({ id, first_name: `U${id}` }, BOT_TOKEN)}`;
    const call = async (id: number, path: string, body?: unknown) => {
      const r = await app.inject({
        method: 'POST',
        url: `/api${path}`,
        headers: { authorization: authFor(id) },
        payload: (body ?? {}) as object,
      });
      return { status: r.statusCode, json: r.json() as any };
    };
    const created = await call(CLIENT, '/orders', {
      type: 'PAYMENT_LINK',
      url: 'https://checkout.stripe.com/c/pay/abc',
      service: 'Netflix',
      description: 'Premium',
      amount: '10',
      currency: 'USD',
    });
    const id = created.json.order.id;
    await call(ADMIN, `/admin/orders/${id}/quote`, { version: 1 });
    h.sent.length = 0;
    const conf = await call(CLIENT, `/orders/${id}/confirm`, { version: 2 });
    expect(conf.json.order).toMatchObject({ status: 'AWAITING_PAYMENT', actions: ['pay', 'cancel'] });
    expect(conf.json.order.payment).toMatchObject({ method: 'СБП', awaitingRequisites: false });
    expect(allTo(CLIENT)).toMatch(/СБП: \+7 900 111-22-33/); // реквизиты ушли клиенту в чат
    expect(allTo(ADMIN)).toMatch(/отправлены клиенту автоматически/);
    expect(JSON.stringify(conf.json)).not.toContain('+7 900 111-22-33'); // но в ответ API текст не попадает
    void click;
    void orderVersion;
  });
});
