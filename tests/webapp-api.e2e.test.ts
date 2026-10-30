import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sumEntries } from '../src/domain/ledger.js';
import { createHttpServer } from '../src/http/server.js';
import { buildSignedInitData } from '../src/http/api/webapp-auth.js';
import { ADMIN, BOT_TOKEN, CLIENT, STRANGER, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;
const CLIENT2 = 2001;

describe.skipIf(!url)('Mini App API (initData auth, real DB)', () => {
  const dist = mkdtempSync(join(tmpdir(), 'webapp-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');

  const h = url ? createHarness(url, { WEBAPP_DIST: dist }) : (undefined as never);
  const { db, deps, say, click, lastTo, allTo, onboard } = h ?? ({} as typeof h);
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createHttpServer({ deps, bot: h.bot });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });
  beforeEach(() => h.reset());

  const authFor = (id: number, now = new Date()) =>
    `tma ${buildSignedInitData({ id, first_name: `U${id}` }, BOT_TOKEN, now)}`;

  async function call(id: number | null, method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await app.inject({
      method,
      url: `/api${path}`,
      headers: id === null ? {} : { authorization: authFor(id) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, json: res.json() as any, headers: res.headers, raw: res.body };
  }

  const goodOrder = {
    type: 'PAYMENT_LINK',
    url: 'https://checkout.stripe.com/c/pay/abc',
    service: 'Netflix',
    description: 'Premium',
    amount: '10',
    currency: 'usd',
    period: 'ONE',
  };

  /** Админ + клиент; второй клиент (2001) заводится через инвайт. */
  async function setup() {
    const client = await onboard();
    await say(ADMIN, '/invite второй');
    const code = /start=([\w-]+)/.exec(lastTo(ADMIN)!.text)![1]!;
    await say(CLIENT2, `/start ${code}`);
    return client;
  }

  it('rejects missing, forged, expired and unknown-user credentials; blocked users are cut off', async () => {
    await setup();
    expect((await call(null, 'GET', '/me')).status).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'tma garbage' } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer x' } })).statusCode,
    ).toBe(401);

    const forged = `tma ${buildSignedInitData({ id: CLIENT, first_name: 'x' }, '999:ANOTHERTOKENANOTHERTOKEN')}`;
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: forged } })).statusCode).toBe(
      401,
    );

    const old = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: authFor(CLIENT, new Date(Date.now() - 2 * 86_400_000)) },
    });
    expect(old.statusCode).toBe(401);

    expect((await call(STRANGER, 'GET', '/me')).status).toBe(403); // валидная подпись, но не наш пользователь

    const me = await call(CLIENT, 'GET', '/me');
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ role: 'CLIENT', balanceMinor: '0' });
    expect(me.json.methods).toBeUndefined(); // способ перевода выбирает админ, клиенту список не нужен
    expect(me.json.payModes).toEqual([{ mode: 'PREPAY', label: expect.any(String) }]);
    expect(me.headers['cache-control']).toBe('no-store');

    const admin = await call(ADMIN, 'GET', '/me');
    expect(admin.json).toMatchObject({ role: 'ADMIN' });
    expect(admin.json.cards).toHaveLength(1);
    expect(admin.json.methods).toEqual([
      { id: 1, title: 'СБП', hasSavedText: false },
      { id: 2, title: 'Прямой перевод', hasSavedText: false },
      { id: 3, title: 'Наличные', hasSavedText: false },
    ]);

    await say(ADMIN, `/block ${(await db.user.findFirstOrThrow({ where: { telegramId: BigInt(CLIENT) } })).id}`);
    expect((await call(CLIENT, 'GET', '/me')).status).toBe(403);
  });

  it('enforces roles and ownership', async () => {
    await setup();
    const created = await call(CLIENT, 'POST', '/orders', goodOrder);
    expect(created.status).toBe(201);
    const id = created.json.order.id;

    expect((await call(CLIENT2, 'GET', `/orders/${id}`)).status).toBe(404); // чужая заявка «не существует»
    expect((await call(CLIENT2, 'POST', `/orders/${id}/cancel`, { version: 1 })).status).toBe(404);
    expect((await call(CLIENT2, 'GET', '/orders')).json.orders).toEqual([]);

    for (const [m, p] of [
      ['GET', '/admin/orders'],
      ['GET', '/admin/stats'],
      ['POST', `/admin/orders/${id}/quote`],
    ] as const) {
      expect((await call(CLIENT, m, p, m === 'POST' ? { version: 1 } : undefined)).status).toBe(403);
    }
    expect((await call(ADMIN, 'POST', '/orders', goodOrder)).status).toBe(403); // админ не создаёт заявки как клиент

    // админ видит заявку и клиента в очереди; метка домена
    const q = await call(ADMIN, 'GET', '/admin/orders');
    expect(q.json.orders).toHaveLength(1);
    expect(q.json.orders[0]).toMatchObject({
      id,
      trusted: true,
      client: { name: 'U2000' },
      actions: ['quote', 'reject'],
    });
  });

  it('validates new orders like the bot does', async () => {
    await setup();
    const bad = async (patch: object, code: string, status = 422) => {
      const r = await call(CLIENT, 'POST', '/orders', { ...goodOrder, ...patch });
      expect([r.status, r.json.error]).toEqual([status, code]);
    };
    await bad({ url: 'https://bit.ly/abc' }, 'link_shortener');
    await bad({ url: 'http://shop.example.com/x' }, 'link_not_https');
    await bad({ url: undefined }, 'url_required');
    await bad({ description: 'логин: ivan пароль: Qwerty123' }, 'secret_detected');
    await bad({ comment: 'моя карта 4242 4242 4242 4242' }, 'secret_detected');
    await bad({ currency: 'ZZZ' }, 'rate_unavailable');
    await bad({ currency: 'RUB' }, 'rub_currency');
    await bad({ amount: '12.345' }, 'bad_amount');
    await bad({ amount: '0' }, 'amount_limit');
    await bad({ payMode: 'BALANCE' }, 'pay_mode_unavailable');
    await bad({ payMode: 'PAY_LATER' }, 'pay_mode_unavailable');
    await bad({ type: 'GIFT_CARD', url: undefined, description: undefined }, 'region_required');
    await bad({ service: 'x' }, 'validation', 400);
    await bad({ type: 'NOPE' }, 'validation', 400);
    expect(await db.order.count()).toBe(0);

    const r = await call(CLIENT, 'POST', '/orders', { ...goodOrder, url: 'https://unknown-shop.example.org/pay' });
    expect(r.status).toBe(201);
    expect(r.json.untrustedDomain).toBe(true);
    expect(allTo(ADMIN)).toMatch(/НЕИЗВЕСТНЫЙ ДОМЕН/); // админу ушла такая же карточка, как из бота
    // GIFT_CARD: ссылка и описание отбрасываются
    const g = await call(CLIENT, 'POST', '/orders', {
      type: 'GIFT_CARD',
      service: 'Steam',
      region: 'TR',
      amount: '25',
      currency: 'USD',
      url: 'https://x.example.org',
      description: 'зачем',
    });
    expect(g.status).toBe(201);
    expect(g.json.order).toMatchObject({ url: null, description: null, giftRegion: 'TR' });
  });

  it('full lifecycle through the API, with stale-version protection and consistent ledger', async () => {
    const client = await setup();
    const create = await call(CLIENT, 'POST', '/orders', goodOrder);
    const { id, version } = create.json.order;
    expect(create.json.order).toMatchObject({
      status: 'NEW',
      amountMinor: '1000',
      currency: 'USD',
      actions: ['cancel'],
    });
    expect(allTo(ADMIN)).toMatch(/Новая заявка/);

    const quote = await call(ADMIN, 'POST', `/admin/orders/${id}/quote`, { version });
    expect(quote.json.order).toMatchObject({ status: 'QUOTED', totalMinor: '96400', version: 2, rate: '90,00' });
    expect(allTo(CLIENT)).toMatch(/рассчитана/);
    expect((await call(ADMIN, 'POST', `/admin/orders/${id}/quote`, { version })).json).toMatchObject({
      error: 'stale',
      currentVersion: 2,
    });

    const mine = await call(CLIENT, 'GET', `/orders/${id}`);
    expect(mine.json.order.actions).toEqual(['confirm', 'cancel']);
    // клиент способ не выбирает; админ получает карточку «пришли реквизиты»
    const conf = await call(CLIENT, 'POST', `/orders/${id}/confirm`, {
      version: 2,
      methodId: 3 /* лишнее поле игнорируется */,
    });
    expect(conf.json.order).toMatchObject({ status: 'AWAITING_PAYMENT', dueMinor: '96400', actions: ['cancel'] });
    expect(conf.json.order.payment).toMatchObject({ method: null, awaitingRequisites: true });
    expect(allTo(ADMIN)).toMatch(/выбери способ и отправь реквизиты/);
    expect((await call(CLIENT, 'POST', `/orders/${id}/paid`, { version: 3 })).json.error).toBe('requisites_not_sent');

    // админ присылает реквизиты (только он; с проверками)
    const req = (body: object, who = ADMIN) =>
      call(who, 'POST', `/admin/orders/${id}/requisites`, { version: 3, ...body });
    expect((await req({ methodId: 1, text: 'x' }, CLIENT)).status).toBe(403);
    expect((await req({ methodId: 999, text: 'СБП +7 900 111-22-33' })).json.error).toBe('method_not_found');
    expect((await req({ methodId: 1 })).json.error).toBe('text_required'); // готового текста у способа нет
    expect((await req({ methodId: 1, text: 'СБП +7 900 111-22-33, MARKER-API-1', version: 2 })).json.error).toBe(
      'stale',
    );
    const sent1 = await req({ methodId: 1, text: 'СБП +7 900 111-22-33, MARKER-API-1' });
    expect(sent1.json.order).toMatchObject({ status: 'AWAITING_PAYMENT', version: 3 });
    expect(sent1.json.order.payment).toMatchObject({ method: 'СБП', requiresReceipt: true, awaitingRequisites: false });
    expect(allTo(CLIENT)).toMatch(/MARKER-API-1/); // клиенту ушло в чат
    expect(JSON.stringify((await call(CLIENT, 'GET', `/orders/${id}`)).json)).not.toContain('MARKER-API-1'); // API текст не отдаёт
    expect((await call(CLIENT, 'GET', `/orders/${id}`)).json.order.actions).toEqual(['pay', 'cancel']);
    expect((await call(CLIENT, 'POST', `/orders/${id}/paid`, { version: 3 })).json.error).toBe('receipt_required'); // чек — только через бота

    // клиент меняет способ на «Наличные» (чек не нужен) — через повторное подтверждение нельзя; поэтому делаем новую заявку
    await call(CLIENT, 'POST', `/orders/${id}/cancel`, { version: 3 });
    expect((await call(CLIENT, 'POST', `/orders/${id}/cancel`, { version: 3 })).status).toBe(409); // повторный клик

    const o2 = (await call(CLIENT, 'POST', '/orders', goodOrder)).json.order;
    await call(ADMIN, 'POST', `/admin/orders/${o2.id}/quote`, { version: o2.version });
    await call(CLIENT, 'POST', `/orders/${o2.id}/confirm`, { version: 2 });
    await call(ADMIN, 'POST', `/admin/orders/${o2.id}/requisites`, {
      version: 3,
      methodId: 3,
      text: 'Наличными при встрече',
    });
    const paid = await call(CLIENT, 'POST', `/orders/${o2.id}/paid`, { version: 3 });
    expect(paid.json.order).toMatchObject({ status: 'PAYMENT_CHECK', actions: ['cancel'] });
    expect(allTo(ADMIN)).toMatch(/отметил оплату/);

    const adm = await call(ADMIN, 'GET', `/admin/orders/${o2.id}`);
    expect(adm.json.order.actions.sort()).toEqual(['confirm_payment', 'payment_not_found', 'reject']);
    const [c1, c2] = await Promise.all([
      call(ADMIN, 'POST', `/admin/orders/${o2.id}/confirm-payment`, { version: 4 }),
      call(ADMIN, 'POST', `/admin/orders/${o2.id}/confirm-payment`, { version: 4 }),
    ]);
    expect([c1.status, c2.status].sort()).toEqual([200, 409]);

    expect(
      (await call(ADMIN, 'POST', `/admin/orders/${o2.id}/complete`, { version: 5, cardId: 77, actual: '10' })).json
        .error,
    ).toBe('card_not_found');
    expect(
      (await call(ADMIN, 'POST', `/admin/orders/${o2.id}/complete`, { version: 5, cardId: 1, actual: 'abc' })).json
        .error,
    ).toBe('bad_amount');
    const done = await call(ADMIN, 'POST', `/admin/orders/${o2.id}/complete`, {
      version: 5,
      cardId: 1,
      actual: '10,50',
    });
    expect(done.status).toBe(200);
    expect(done.json.order).toMatchObject({ status: 'DONE', diffMinor: '-2700', actions: [] });
    expect(done.json.settlement).toEqual({ actualRubMinor: '94500', baseCostMinor: '91800', diffMinor: '-2700' });
    expect(sumEntries(await db.ledgerEntry.findMany({ where: { clientId: client.id } }))).toBe(-2700n);
    expect(allTo(CLIENT)).toMatch(/Доплата/);

    const bal = await call(CLIENT, 'GET', '/balance');
    expect(bal.json).toMatchObject({ balanceMinor: '-2700', debtMinor: '2700' });
    expect(bal.json.entries.map((e: { type: string }) => e.type)).toContain('DIFF_ADJUST');

    const stats = await call(ADMIN, 'GET', '/admin/stats?period=month');
    expect(stats.json).toMatchObject({ count: 1, turnoverMinor: '96400', costMinor: '94500', profitMinor: '1900' });
    expect(stats.json.byService[0]).toMatchObject({ label: 'Netflix', count: 1 });
    expect((await call(ADMIN, 'GET', '/admin/stats?period=вчера')).status).toBe(400);
    expect((await call(ADMIN, 'GET', '/admin/rate/usd')).json).toMatchObject({
      currency: 'USD',
      rate: '90,00',
      source: 'MANUAL',
    });
  });

  it('gift card: code is required, delivered to the client, and never exposed by the API', async () => {
    await setup();
    const g = (
      await call(CLIENT, 'POST', '/orders', {
        type: 'GIFT_CARD',
        service: 'Steam',
        region: 'TR',
        amount: '25',
        currency: 'USD',
      })
    ).json.order;
    await call(ADMIN, 'POST', `/admin/orders/${g.id}/quote`, { version: 1 });
    await call(CLIENT, 'POST', `/orders/${g.id}/confirm`, { version: 2 });
    await call(ADMIN, 'POST', `/admin/orders/${g.id}/requisites`, { version: 3, methodId: 3, text: 'Наличными' });
    await call(CLIENT, 'POST', `/orders/${g.id}/paid`, { version: 3 });
    await call(ADMIN, 'POST', `/admin/orders/${g.id}/confirm-payment`, { version: 4 });

    const noCode = await call(ADMIN, 'POST', `/admin/orders/${g.id}/complete`, { version: 5, cardId: 1, actual: '25' });
    expect(noCode.json.error).toBe('gift_code_required');
    const ok = await call(ADMIN, 'POST', `/admin/orders/${g.id}/complete`, {
      version: 5,
      cardId: 1,
      actual: '25',
      giftCode: 'SECRET-CODE-777',
    });
    expect(ok.status).toBe(200);
    expect(allTo(CLIENT)).toContain('SECRET-CODE-777'); // ушёл клиенту в чат
    const stored = await db.order.findUniqueOrThrow({ where: { id: g.id } });
    expect(stored.giftCodeEnc).not.toBeNull();

    for (const who of [ADMIN, CLIENT]) {
      const path = who === ADMIN ? `/admin/orders/${g.id}` : `/orders/${g.id}`;
      const raw = (await call(who, 'GET', path)).raw;
      expect(raw).not.toContain('SECRET-CODE-777');
      expect(raw.toLowerCase()).not.toContain('giftcodeenc');
    }
  });

  it('subscription renewal, new-link and requote via the API', async () => {
    await setup();
    const sub = (await call(CLIENT, 'POST', '/orders', { ...goodOrder, period: 'MONTH' })).json.order;
    expect(sub).toMatchObject({ isSubscription: true, periodKind: 'MONTH' });
    await call(ADMIN, 'POST', `/admin/orders/${sub.id}/quote`, { version: 1 });
    await call(CLIENT, 'POST', `/orders/${sub.id}/confirm`, { version: 2 });
    await call(ADMIN, 'POST', `/admin/orders/${sub.id}/requisites`, { version: 3, methodId: 3, text: 'Наличными' });
    await call(CLIENT, 'POST', `/orders/${sub.id}/paid`, { version: 3 });
    await call(ADMIN, 'POST', `/admin/orders/${sub.id}/confirm-payment`, { version: 4 });

    // ссылка не работает -> клиент присылает новую (с проверкой)
    await call(ADMIN, 'POST', `/admin/orders/${sub.id}/link-invalid`, { version: 5 });
    expect((await call(CLIENT, 'GET', `/orders/${sub.id}`)).json.order.actions).toEqual(['new_link']);
    expect(
      (await call(CLIENT, 'POST', `/orders/${sub.id}/new-link`, { version: 6, url: 'https://t.co/x' })).json.error,
    ).toBe('link_shortener');
    const nl = await call(CLIENT, 'POST', `/orders/${sub.id}/new-link`, {
      version: 6,
      url: 'https://pay.paddle.com/new',
    });
    expect(nl.json.order).toMatchObject({ status: 'IN_PROGRESS', urlDomain: 'pay.paddle.com' });

    await call(ADMIN, 'POST', `/admin/orders/${sub.id}/complete`, { version: 7, cardId: 1, actual: '10' });
    const done = (await call(CLIENT, 'GET', `/orders/${sub.id}`)).json.order;
    expect(done.actions).toEqual(['renew']);
    expect(done.nextChargeAt).not.toBeNull();

    expect((await call(CLIENT, 'POST', `/orders/${sub.id}/renew`, { payMode: 'PREPAY' })).json.error).toBe(
      'url_required',
    );
    const renewed = await call(CLIENT, 'POST', `/orders/${sub.id}/renew`, {
      url: 'https://pay.paddle.com/renew',
      payMode: 'PREPAY',
    });
    expect(renewed.status).toBe(201);
    expect(renewed.json.order).toMatchObject({ status: 'NEW', renewedFromId: sub.id, isSubscription: true });
    expect(
      (
        await call(CLIENT, 'POST', `/orders/${sub.id}/renew`, {
          url: 'https://pay.paddle.com/again',
          payMode: 'PREPAY',
        })
      ).json,
    ).toMatchObject({ error: 'renewal_exists', orderId: renewed.json.order.id });

    // истёкший расчёт -> пересчёт клиентом
    const r = renewed.json.order;
    await call(ADMIN, 'POST', `/admin/orders/${r.id}/quote`, { version: 1 });
    await db.order.update({ where: { id: r.id }, data: { quoteExpiresAt: new Date(Date.now() - 1000) } });
    expect((await call(CLIENT, 'POST', `/orders/${r.id}/confirm`, { version: 2 })).json.expired).toBe(true);
    const exp = (await call(CLIENT, 'GET', `/orders/${r.id}`)).json.order;
    expect(exp).toMatchObject({ status: 'EXPIRED', actions: ['requote', 'cancel'] });
    expect((await call(CLIENT, 'POST', `/orders/${r.id}/requote`, { version: exp.version })).json.order.status).toBe(
      'QUOTED',
    );
  });

  it('serves the static app with security headers; missing files 404; API 404 is JSON', async () => {
    await setup();
    const page = await app.inject({ method: 'GET', url: '/app/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'self' https://web.telegram.org");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    const asset = await app.inject({ method: 'GET', url: '/app/assets/index-abc123.js' });
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await app.inject({ method: 'GET', url: '/app/nope.js' })).statusCode).toBe(404);
    const unknown = await call(CLIENT, 'GET', '/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe('not_found');
    // файлы вне каталога раздавать нельзя
    expect((await app.inject({ method: 'GET', url: '/app/../package.json' })).statusCode).not.toBe(200);
    void click;
  });
});
