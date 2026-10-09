import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeGiftCodes, sendSubscriptionReminders } from '../src/services/scheduler.js';
import { ADMIN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('stage 4 e2e: subscriptions, reminders, stats, export, gift-code purge', () => {
  const h = url ? createHarness(url) : (undefined as never);
  const { db, deps, say, photo, click, lastTo, allTo, alerts, onboard, orderVersion, requisites } = h ?? ({} as typeof h);
  afterAll(async () => db.$disconnect());
  beforeEach(() => h.reset());

  /** Заявка на 10 USD (итог 964 ₽). `period`: ONE | MONTH | YEAR. */
  async function newOrder(opts: { service?: string; period?: string; url?: string } = {}) {
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, opts.url ?? 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, opts.service ?? 'Netflix');
    await say(CLIENT, 'Premium');
    await say(CLIENT, '10 USD');
    await click(CLIENT, `w:period:${opts.period ?? 'ONE'}`);
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    return db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
  }

  /** Прогоняет заявку PREPAY от NEW до DONE. `actual` — фактическое списание в USD. */
  async function runToDone(id: number, actual = '10,50') {
    await click(ADMIN, `o:${id}:${await orderVersion(id)}:q`);
    await click(CLIENT, `o:${id}:${await orderVersion(id)}:cf`);
    await requisites(id, 1);
    await click(CLIENT, `o:${id}:${await orderVersion(id)}:pd`);
    await photo(CLIENT);
    await click(ADMIN, `o:${id}:${await orderVersion(id)}:pc`);
    await click(ADMIN, `o:${id}:${await orderVersion(id)}:dn`);
    await click(ADMIN, 'w:card:1');
    await say(ADMIN, actual);
    await click(ADMIN, 'w:rate:ok');
    await click(ADMIN, 'w:shot:skip');
    await click(ADMIN, 'w:confirm:ok');
    return db.order.findUniqueOrThrow({ where: { id } });
  }

  const at = (o: { nextChargeAt: Date | null }, deltaDays: number, hourUtc = 10) => {
    const d = new Date(o.nextChargeAt!.getTime() + deltaDays * 86_400_000);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d;
  };

  it('subscription: nextChargeAt is set, reminder goes to client+admin once, renewal needs a fresh link and is not duplicated', async () => {
    await onboard();
    const o = await newOrder({ period: 'MONTH' });
    expect(o).toMatchObject({ isSubscription: true, periodKind: 'MONTH' });
    const done = await runToDone(o.id);
    expect(done.status).toBe('DONE');
    const days = (done.nextChargeAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);

    await say(ADMIN, '/subs');
    expect(lastTo(ADMIN)!.text).toMatch(/Netflix/);

    // слишком рано (за 10 дней) и слишком рано в течение суток (08:00 МСК) — напоминаний нет
    expect(await sendSubscriptionReminders(deps, at(done, -10))).toBe(0);
    expect(await sendSubscriptionReminders(deps, at(done, -2, 5))).toBe(0);
    // за 2 дня после 10:00 МСК — напоминание
    h.sent.length = 0;
    expect(await sendSubscriptionReminders(deps, at(done, -2))).toBe(1);
    expect(allTo(CLIENT)).toMatch(/Подписка «Netflix»/);
    expect(h.cbData(h.lastTo(CLIENT))).toEqual([`s:${o.id}:rn`, `s:${o.id}:no`]);
    expect(allTo(ADMIN)).toMatch(/Скоро списание по подписке/);
    expect(await sendSubscriptionReminders(deps, at(done, -2, 12))).toBe(0); // повторно не шлём

    // продление: нужна свежая ссылка (старую не копируем)
    await click(CLIENT, `s:${o.id}:rn`);
    expect(lastTo(CLIENT)!.text).toMatch(/https-ссылку/);
    await say(CLIENT, 'https://pay.paddle.com/checkout/fresh-link');
    const renewal = await db.order.findFirstOrThrow({ where: { renewedFromId: o.id } });
    expect(renewal).toMatchObject({
      status: 'NEW', isSubscription: true, periodKind: 'MONTH', service: 'Netflix', amountMinor: 1000n,
      currency: 'USD', url: 'https://pay.paddle.com/checkout/fresh-link', urlDomain: 'pay.paddle.com',
    });
    expect(allTo(ADMIN)).toMatch(/Продление подписки/);

    // повторное нажатие не создаёт вторую заявку
    await click(CLIENT, `s:${o.id}:rn`);
    expect(await db.order.count({ where: { renewedFromId: o.id } })).toBe(1);
    expect(lastTo(CLIENT)!.text).toMatch(/уже оформлено/);

    // продление проходит весь цикл и получает собственную дату следующего списания
    const renewed = await runToDone(renewal.id);
    expect(renewed.nextChargeAt!.getTime()).toBeGreaterThan(done.nextChargeAt!.getTime());
  });

  it('parallel renew clicks create exactly one renewal', async () => {
    const client = await onboard();
    const o = await newOrder({ period: 'MONTH' });
    await runToDone(o.id);
    const over = { url: 'https://pay.paddle.com/x', urlDomain: 'pay.paddle.com', payMode: 'PREPAY' as const };
    const res = await Promise.allSettled([
      deps.orders.renew(o.id, client.id, over),
      deps.orders.renew(o.id, client.id, over),
      deps.orders.renew(o.id, client.id, over),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.order.count({ where: { renewedFromId: o.id } })).toBe(1);
  });

  it('"Не продлевать" stops reminders; no reminders when renewal exists, for blocked clients or for foreign users', async () => {
    const client = await onboard();
    const a = await newOrder({ period: 'MONTH', service: 'Alpha' });
    const done = await runToDone(a.id);
    await click(ADMIN, `s:${a.id}:no`); // админ не может нажимать клиентские кнопки
    expect(alerts()).toContain('Нет доступа.');
    expect((await db.order.findUniqueOrThrow({ where: { id: a.id } })).nextChargeAt).not.toBeNull();

    await click(CLIENT, `s:${a.id}:no`);
    expect((await db.order.findUniqueOrThrow({ where: { id: a.id } })).nextChargeAt).toBeNull();
    expect(await sendSubscriptionReminders(deps, at(done, -2))).toBe(0);
    await say(ADMIN, '/subs');
    expect(lastTo(ADMIN)!.text).toMatch(/Активных подписок нет/);

    const b = await newOrder({ period: 'MONTH', service: 'Bravo' });
    const doneB = await runToDone(b.id);
    await deps.orders.renew(b.id, client.id, { url: 'https://pay.paddle.com/y', urlDomain: 'pay.paddle.com', payMode: 'PREPAY' });
    expect(await sendSubscriptionReminders(deps, at(doneB, -2))).toBe(0); // продление уже есть

    const c = await newOrder({ period: 'YEAR', service: 'Charlie' });
    const doneC = await runToDone(c.id);
    await say(ADMIN, `/block ${client.id}`);
    expect(await sendSubscriptionReminders(deps, at(doneC, -2))).toBe(0); // заблокированному не пишем
  });

  it('gift card codes are wiped from the DB after the retention deadline', async () => {
    await onboard();
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:GIFT_CARD');
    await say(CLIENT, 'Steam');
    await say(CLIENT, 'TR');
    await say(CLIENT, '25 USD');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    const o = await db.order.findFirstOrThrow();
    await click(ADMIN, `o:${o.id}:1:q`);
    await click(CLIENT, `o:${o.id}:2:cf`);
    await requisites(o.id, 3, 'наличные'); // без чека
    await click(CLIENT, `o:${o.id}:3:pd`);
    await click(ADMIN, `o:${o.id}:4:pc`);
    await click(ADMIN, `o:${o.id}:5:dn`);
    await say(ADMIN, 'ABCD-EFGH-1234');
    await click(ADMIN, 'w:card:1');
    await say(ADMIN, '25');
    await click(ADMIN, 'w:rate:ok');
    await click(ADMIN, 'w:shot:skip');
    await click(ADMIN, 'w:confirm:ok');

    let cur = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(cur.giftCodeEnc).not.toBeNull();
    expect(await purgeGiftCodes(deps, new Date())).toBe(0); // срок ещё не вышел
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).giftCodeEnc).not.toBeNull();

    const later = new Date(cur.giftCodeDeleteAt!.getTime() + 1000);
    expect(await purgeGiftCodes(deps, later)).toBe(1);
    cur = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(cur).toMatchObject({ giftCodeEnc: null, giftCodeDeleteAt: null, status: 'DONE' });
    expect(await purgeGiftCodes(deps, later)).toBe(0);
  });

  it('/stats and /export: turnover, cost, profit, grouping, safe CSV', async () => {
    await onboard();
    const a = await newOrder({ service: 'Netflix' });
    await runToDone(a.id, '10,50'); // оценка 918 ₽, расход 945 ₽, прибыль 964−945 = 19 ₽
    const b = await newOrder({ service: '=SUM(1)' });
    await runToDone(b.id, '10'); // расход 900 ₽, прибыль 64 ₽
    await newOrder({ service: 'Open' }); // создана, не выполнена

    h.sent.length = 0;
    await say(ADMIN, '/stats');
    const text = lastTo(ADMIN)!.text;
    expect(text).toMatch(/Выполнено в периоде: <b>2<\/b>/);
    expect(text).toMatch(/Оборот[^\n]*<b>1 928 ₽<\/b>/);
    expect(text).toMatch(/Фактические расходы: 1 845 ₽/);
    expect(text).toMatch(/Валовая прибыль: <b>83 ₽<\/b>/);
    expect(text).toMatch(/Создано заявок: 3/);
    expect(text).toMatch(/Visa ··4417 — 20,50 USD ≈ 1 845 ₽ \(2\)/);
    expect(text).toMatch(/Netflix — 964 ₽ \(1\)/);

    await say(ADMIN, '/stats prev');
    expect(lastTo(ADMIN)!.text).toMatch(/Выполнено в периоде: <b>0<\/b>/);
    await say(ADMIN, '/stats вчера');
    expect(lastTo(ADMIN)!.text).toMatch(/Не понял период/);
    await say(CLIENT, '/stats');
    expect(lastTo(CLIENT)!.text).toMatch(/только администратору/);

    h.sent.length = 0;
    await say(ADMIN, '/export all');
    const docs = h.sent.filter((s) => s.method === 'sendDocument');
    expect(docs).toHaveLength(2);
    const body = (i: number) => Buffer.from((docs[i]!.payload.document as { fileData: Buffer }).fileData).toString('utf8');
    const ordersCsv = body(0);
    const ledgerCsv = body(1);
    expect(ordersCsv.charCodeAt(0)).toBe(0xfeff); // BOM для Excel
    expect(ordersCsv).toMatch(/^﻿id,created_at,status,type/);
    expect(ordersCsv.split('\r\n').filter(Boolean)).toHaveLength(4); // заголовок + 3 заявки
    expect(ordersCsv).toContain("'=SUM(1)"); // формула обезврежена
    expect(ordersCsv).not.toMatch(/,=SUM/);
    expect(ordersCsv).toContain('checkout.stripe.com');
    expect(ordersCsv).not.toContain('/c/pay/abc'); // полная ссылка в экспорт не попадает
    expect(ordersCsv).toContain('964.00');
    expect(ledgerCsv).toMatch(/PAYMENT_RECEIVED,964\.00/);
    expect(ledgerCsv).toMatch(/DIFF_ADJUST,-27\.00/);
    expect(docs[0]!.payload.document.filename).toBe('orders_all.csv');
    expect(docs[1]!.payload.document.filename).toBe('ledger_all.csv');

    await say(ADMIN, '/export 2000-01');
    expect(lastTo(ADMIN)!.text).toMatch(/данных нет/);
  });
});
