import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { buildSignedInitData } from '../src/http/api/webapp-auth.js';
import { ADMIN, BOT_TOKEN, CLIENT, STRANGER, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;
const CLIENT2 = 2001;

describe.skipIf(!url)('/calc, service suggestions, re-order', () => {
  const h = url ? createHarness(url) : (undefined as never);
  const { db, deps, say, photo, click, lastTo, allTo, onboard, orderVersion, requisites } = h ?? ({} as typeof h);
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createHttpServer({ deps: h.deps, bot: h.bot });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });
  beforeEach(() => h.reset());

  const call = async (id: number, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await app.inject({
      method,
      url: `/api${path}`,
      headers: { authorization: `tma ${buildSignedInitData({ id, first_name: 'U' }, BOT_TOKEN)}` },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: r.statusCode, json: r.json() as any };
  };

  async function newOrder(service = 'Netflix', amount = '10 USD', period = 'ONE') {
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, service);
    await say(CLIENT, 'Premium');
    await say(CLIENT, amount);
    await click(CLIENT, `w:period:${period}`);
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    return db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
  }
  async function toDone(id: number) {
    await click(ADMIN, `o:${id}:${await orderVersion(id)}:q`);
    await click(CLIENT, `o:${id}:${await orderVersion(id)}:cf`);
    await requisites(id, 1);
    await click(CLIENT, `o:${id}:${await orderVersion(id)}:pd`);
    await photo(CLIENT);
    await click(ADMIN, `o:${id}:${await orderVersion(id)}:pc`);
    await click(ADMIN, `o:${id}:${await orderVersion(id)}:dn`);
    await click(ADMIN, 'w:card:1');
    await say(ADMIN, '10');
    await click(ADMIN, 'w:rate:ok');
    await click(ADMIN, 'w:shot:skip');
    await click(ADMIN, 'w:confirm:ok');
  }

  it('/calc: estimate by current rate and settings; validation; denied to strangers', async () => {
    await onboard();
    await say(CLIENT, '/calc 15,99 USD'); // 15,99 × 90 × 1,02 × 1,05 = 1541,2 -> 1 542 ₽
    expect(lastTo(CLIENT)!.text).toMatch(/15,99 USD ≈ <b>1 542 ₽<\/b>/);
    expect(lastTo(CLIENT)!.text).toMatch(/Курс: 90,00/);
    await say(CLIENT, '/calc 10'); // валюта по умолчанию USD
    expect(lastTo(CLIENT)!.text).toMatch(/≈ <b>964 ₽<\/b>/);
    for (const bad of ['/calc', '/calc abc', '/calc 10 RUB', '/calc 0 USD', '/calc 1.234 USD']) {
      await say(CLIENT, bad);
      expect(lastTo(CLIENT)!.text, bad).toMatch(/Использование: \/calc/);
    }
    await say(CLIENT, '/calc 10 ZZZ');
    expect(lastTo(CLIENT)!.text).toMatch(/Не нашёл курс для ZZZ/);
    await say(ADMIN, '/calc 10 USD'); // админу тоже
    expect(lastTo(ADMIN)!.text).toMatch(/964 ₽/);
    await say(STRANGER, '/calc 10 USD');
    expect(lastTo(STRANGER)!.text).toMatch(/закрытый бот/);
  });

  it('presets: admin manages them; clients pick a service and get amount/currency/period "as before"; estimate in the summary', async () => {
    await onboard();
    await say(ADMIN, '/preset_add Netflix | PAYMENT_LINK | USD | 15,99 | MONTH');
    expect(lastTo(ADMIN)!.text).toMatch(/Добавлено: #1 Netflix/);
    await say(ADMIN, '/preset_add Netflix');
    expect(lastTo(ADMIN)!.text).toMatch(/уже есть/);
    await say(ADMIN, '/preset_add X');
    expect(lastTo(ADMIN)!.text).toMatch(/Название сервиса/);
    await say(ADMIN, '/preset_add Steam | GIFT_CARD | USD | 20');
    await say(ADMIN, '/presets');
    expect(lastTo(ADMIN)!.text).toMatch(/Netflix — PAYMENT_LINK, 15,99 USD, мес/);
    await say(CLIENT, '/preset_add Hack | OTHER');
    expect(await db.servicePreset.count()).toBe(2);

    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    expect(h.cbData(lastTo(CLIENT))).toContain('w:service:0');
    expect(JSON.stringify(lastTo(CLIENT)!.payload.reply_markup)).toContain('⭐ Netflix · 15,99 USD');
    expect(JSON.stringify(lastTo(CLIENT)!.payload.reply_markup)).not.toContain('Steam'); // другой тип заявки
    await click(CLIENT, 'w:service:0');
    await say(CLIENT, 'Premium'); // описание
    expect(JSON.stringify(lastTo(CLIENT)!.payload.reply_markup)).toContain('Как раньше: 15,99 USD');
    await click(CLIENT, 'w:amount:last'); // период «месяц» тоже подставился — шаг периода пропущен
    expect(lastTo(CLIENT)!.text).toMatch(/Комментарий/);
    await click(CLIENT, 'w:comment:skip');
    expect(lastTo(CLIENT)!.text).toMatch(/Подписка: месяц/);
    expect(lastTo(CLIENT)!.text).toMatch(/Ориентировочно к оплате: ≈ <b>1 542 ₽<\/b>/);
    await click(CLIENT, 'w:confirm:send');
    expect(await db.order.findFirstOrThrow()).toMatchObject({
      service: 'Netflix',
      amountMinor: 1599n,
      currency: 'USD',
      isSubscription: true,
      periodKind: 'MONTH',
    });

    // у клиента появилась своя история: подсказка 🕘 вытесняет пресет с тем же названием
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    const kb = JSON.stringify(lastTo(CLIENT)!.payload.reply_markup);
    expect(kb).toContain('🕘 Netflix · 15,99 USD');
    expect(kb).not.toContain('⭐ Netflix');
    // название вручную, но известное -> «как раньше» всё равно предлагается; неизвестное — нет
    await say(CLIENT, 'netflix');
    await say(CLIENT, 'Premium');
    expect(JSON.stringify(lastTo(CLIENT)!.payload.reply_markup)).toContain('Как раньше');
    deps.wizards.cancel(CLIENT);
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, 'Совсем новый сервис');
    await say(CLIENT, 'Plan');
    expect(JSON.stringify(lastTo(CLIENT)!.payload.reply_markup)).not.toContain('Как раньше');

    await say(ADMIN, '/preset_del 1');
    expect(lastTo(ADMIN)!.text).toBe('Удалено.');
    await say(ADMIN, '/preset_del 1');
    expect(lastTo(ADMIN)!.text).toBe('Не найдено.');
  });

  it('re-order: finished (non-subscription) / canceled / rejected orders can be repeated with a fresh link; others cannot', async () => {
    await onboard();
    const done = await newOrder('Hetzner', '5 EUR');
    await toDone(done.id);
    const view = await deps.presenter.client((await deps.orders.get(done.id))!);
    expect(h.cbData({ payload: { reply_markup: view.keyboard } } as never)).toContain(
      `o:${done.id}:${await orderVersion(done.id)}:ro`,
    );

    h.sent.length = 0;
    await click(CLIENT, `o:${done.id}:${await orderVersion(done.id)}:ro`);
    expect(lastTo(CLIENT)!.text).toMatch(/https-ссылку/); // старая ссылка не копируется
    await say(CLIENT, 'https://pay.paddle.com/checkout/fresh');
    const again = await db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
    expect(again).toMatchObject({
      status: 'NEW',
      service: 'Hetzner',
      amountMinor: 500n,
      currency: 'EUR',
      url: 'https://pay.paddle.com/checkout/fresh',
      renewedFromId: null,
    });
    expect(again.id).not.toBe(done.id);
    expect(allTo(ADMIN)).toMatch(/Повтор заявки #1/);
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: again.id } })).comment).toBe(
      `Повтор заявки #${done.id}`,
    );

    // отклонённую заявку тоже можно повторить; незавершённую (в работе) — нельзя
    await click(ADMIN, `o:${again.id}:1:rj`);
    await say(ADMIN, 'Сервис недоступен');
    const rejectedView = await deps.presenter.client((await deps.orders.get(again.id))!);
    expect(JSON.stringify(rejectedView.keyboard)).toContain(':ro');
    const open = await newOrder('Other', '3 USD');
    expect(JSON.stringify((await deps.presenter.client((await deps.orders.get(open.id))!)).keyboard)).not.toContain(
      ':ro',
    );
    await click(CLIENT, `o:${open.id}:1:ro`); // подделанная кнопка
    expect(lastTo(CLIENT)!.text).toMatch(/повторить нельзя/);
    expect(deps.wizards.has(CLIENT)).toBe(false);
  });

  it('re-order of subscriptions is refused (they are renewed), of foreign orders — forbidden; gift cards need no link', async () => {
    await onboard();
    await say(ADMIN, '/invite второй');
    const code = /start=([\w-]+)/.exec(lastTo(ADMIN)!.text)![1]!;
    await say(CLIENT2, `/start ${code}`);

    const sub = await newOrder('Spotify', '10 USD', 'MONTH');
    await toDone(sub.id);
    expect(JSON.stringify((await deps.presenter.client((await deps.orders.get(sub.id))!)).keyboard)).not.toContain(
      ':ro',
    );
    await click(CLIENT, `o:${sub.id}:${await orderVersion(sub.id)}:ro`);
    expect(lastTo(CLIENT)!.text).toMatch(/повторить нельзя/);
    await click(CLIENT2, `o:${sub.id}:${await orderVersion(sub.id)}:ro`);
    expect(h.alerts()).toContain('Нет доступа.');

    // подарочная карта: ссылка не нужна — заявка создаётся сразу после нажатия
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:GIFT_CARD');
    await say(CLIENT, 'Steam');
    await say(CLIENT, 'TR');
    await say(CLIENT, '25 USD');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:paymode:PREPAY'); // после выполненной заявки у клиента появился остаток на балансе — выбор способа оплаты
    await click(CLIENT, 'w:confirm:send');
    const gift = await db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
    await click(ADMIN, `o:${gift.id}:1:rj`);
    await say(ADMIN, 'Нет в наличии');
    const before = await db.order.count();
    await click(CLIENT, `o:${gift.id}:${await orderVersion(gift.id)}:ro`);
    expect(await db.order.count()).toBe(before); // ссылка не нужна, но режим оплаты ещё выбирается
    await click(CLIENT, 'w:paymode:PREPAY');
    expect(await db.order.count()).toBe(before + 1);
    expect(await db.order.findFirstOrThrow({ orderBy: { id: 'desc' } })).toMatchObject({
      type: 'GIFT_CARD',
      giftRegion: 'TR',
      url: null,
    });
  });

  it('Mini App API: /calc, /suggestions, reorder', async () => {
    await onboard();
    await say(ADMIN, '/preset_add Netflix | PAYMENT_LINK | USD | 15,99 | MONTH');
    expect((await call(CLIENT, 'GET', '/calc?amount=10&currency=usd')).json).toEqual({
      totalMinor: '96400',
      rate: '90,00',
    });
    for (const [q, code] of [
      ['amount=abc&currency=USD', 'bad_amount'],
      ['amount=0&currency=USD', 'amount_limit'],
      ['amount=10&currency=RUB', 'rub_currency'],
      ['amount=10&currency=ZZZ', 'rate_unavailable'],
    ] as const) {
      expect((await call(CLIENT, 'GET', `/calc?${q}`)).json.error, q).toBe(code);
    }
    expect((await call(CLIENT, 'GET', '/calc?amount=10')).status).toBe(400);

    const sg = (await call(CLIENT, 'GET', '/suggestions?type=PAYMENT_LINK')).json.suggestions;
    expect(sg).toEqual([
      {
        name: 'Netflix',
        type: 'PAYMENT_LINK',
        currency: 'USD',
        amountMinor: '1599',
        periodKind: 'MONTH',
        periodDays: null,
        source: 'preset',
      },
    ]);

    const o = (
      await call(CLIENT, 'POST', '/orders', {
        type: 'PAYMENT_LINK',
        url: 'https://checkout.stripe.com/c/pay/abc',
        service: 'Hetzner',
        description: 'VPS',
        amount: '5',
        currency: 'EUR',
      })
    ).json.order;
    await call(ADMIN, 'POST', `/admin/orders/${o.id}/reject`, { version: 1, reason: 'нет' });
    const view = (await call(CLIENT, 'GET', `/orders/${o.id}`)).json.order;
    expect(view.actions).toEqual(['reorder']);
    expect((await call(CLIENT, 'POST', `/orders/${o.id}/reorder`, { payMode: 'PREPAY' })).json.error).toBe(
      'url_required',
    );
    expect((await call(CLIENT, 'POST', `/orders/${o.id}/reorder`, { url: 'https://bit.ly/x' })).json.error).toBe(
      'link_shortener',
    );
    const ok = await call(CLIENT, 'POST', `/orders/${o.id}/reorder`, {
      url: 'https://pay.paddle.com/p',
      payMode: 'PREPAY',
    });
    expect(ok.status).toBe(201);
    expect(ok.json.order).toMatchObject({
      status: 'NEW',
      service: 'Hetzner',
      amountMinor: '500',
      currency: 'EUR',
      urlDomain: 'pay.paddle.com',
    });
    expect(allTo(ADMIN)).toMatch(/Повтор заявки/);
    expect((await call(CLIENT2, 'POST', `/orders/${o.id}/reorder`, { url: 'https://pay.paddle.com/p' })).status).toBe(
      403,
    ); // не наш пользователь
    const sg2 = (await call(CLIENT, 'GET', '/suggestions')).json.suggestions;
    expect(sg2.map((s: { name: string; source: string }) => `${s.source}:${s.name}`)).toEqual([
      'history:Hetzner',
      'preset:Netflix',
    ]);
  });
});
