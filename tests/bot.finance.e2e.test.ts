import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sumEntries } from '../src/domain/ledger.js';
import { balanceOf } from '../src/services/ledger-service.js';
import { ADMIN as ADMIN_ACTOR } from '../src/services/order-service.js';
import { sendDebtReminders } from '../src/services/scheduler.js';
import { ADMIN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('finance e2e: balance, top-ups, pay later', () => {
  const h = url ? createHarness(url) : (undefined as never);
  const { db, deps, say, photo, click, lastTo, allTo, alerts, onboard, orderVersion, requisites } =
    h ?? ({} as typeof h);
  afterAll(async () => db.$disconnect());
  beforeEach(() => h.reset());

  const ledger = async () =>
    (await db.ledgerEntry.findMany({ orderBy: { id: 'asc' } })).map((l) => [l.type, l.amountMinor]);

  /** Клиент просит пополнение, админ присылает реквизиты, клиент отправляет чек, админ подтверждает. */
  async function topUp(amount: string, opts: { confirm?: boolean } = {}) {
    await say(CLIENT, '➕ Пополнить баланс');
    await say(CLIENT, amount);
    const t = await db.topUp.findFirstOrThrow({ orderBy: { id: 'desc' } });
    await click(ADMIN, `p:${t.id}:1`);
    await say(ADMIN, 'Реквизиты для пополнения');
    await click(CLIENT, `b:rc:${t.id}`);
    await photo(CLIENT);
    if (opts.confirm !== false) await click(ADMIN, `t:${t.id}:ok`);
    return t;
  }

  /** Заявка на 10 USD (итог 964 ₽ при курсе 90 и настройках по умолчанию) с выбранным режимом. */
  async function newOrder(mode?: string) {
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, 'Netflix');
    await say(CLIENT, 'Premium');
    await say(CLIENT, '10 USD');
    await click(CLIENT, 'w:period:ONE');
    await click(CLIENT, 'w:comment:skip');
    if (mode) await click(CLIENT, `w:paymode:${mode}`);
    await click(CLIENT, 'w:confirm:send');
    return db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
  }

  async function quote(id: number) {
    await click(ADMIN, `o:${id}:${await orderVersion(id)}:q`);
  }
  async function finish(id: number, actual: string) {
    await click(ADMIN, `o:${id}:${await orderVersion(id)}:dn`);
    await click(ADMIN, 'w:card:1');
    await say(ADMIN, actual);
    await click(ADMIN, 'w:rate:ok');
    await click(ADMIN, 'w:shot:skip');
    await click(ADMIN, 'w:confirm:ok');
  }

  it('top-up: admin confirms once; reject does not touch the balance; balance screen shows history', async () => {
    await onboard();
    const t = await topUp('5000');
    expect(await ledger()).toEqual([['TOPUP', 500_000n]]);
    expect(allTo(CLIENT)).toMatch(/Пополнение на 5 000 ₽ подтверждено/);
    expect(h.sent.some((s) => s.method === 'sendPhoto' && s.chat === ADMIN)).toBe(true);

    await click(ADMIN, `t:${t.id}:ok`); // двойной клик
    expect(await db.ledgerEntry.count()).toBe(1);
    expect(alerts()).toContain('Уже обработано.');

    const t2 = await topUp('100', { confirm: false });
    await click(ADMIN, `t:${t2.id}:no`);
    expect((await db.topUp.findUniqueOrThrow({ where: { id: t2.id } })).status).toBe('REJECTED');
    expect(await db.ledgerEntry.count()).toBe(1);
    await click(ADMIN, `t:${t2.id}:ok`); // после отказа подтвердить нельзя
    expect(await db.ledgerEntry.count()).toBe(1);

    await say(CLIENT, '💰 Мой баланс');
    expect(lastTo(CLIENT)!.text).toMatch(/Баланс: <b>5 000 ₽<\/b>/);
    expect(lastTo(CLIENT)!.text).toMatch(/Пополнение/);
  });

  it('client cannot confirm top-ups', async () => {
    await onboard();
    const t = await topUp('300', { confirm: false });
    await click(CLIENT, `t:${t.id}:ok`);
    expect((await db.topUp.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('PENDING');
  });

  it('BALANCE with enough funds: reserve -> in progress immediately -> release + charge + diff on DONE', async () => {
    await onboard();
    await topUp('5000');
    const o = await newOrder('BALANCE');
    expect(o.payMode).toBe('BALANCE');
    await quote(o.id);

    await click(CLIENT, `o:${o.id}:${await orderVersion(o.id)}:cf`); // шагов нет: баланс покрывает всё
    let cur = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(cur).toMatchObject({ status: 'IN_PROGRESS', reservedMinor: 96_400n, payDueMinor: 0n });
    expect(await balanceOf(db, cur.clientId)).toBe(403_600n);
    expect(lastTo(ADMIN)!.text).toMatch(/Клиент подтвердил заявку/);
    expect(lastTo(ADMIN)!.text).toMatch(/с баланса/);

    await finish(o.id, '10,50'); // оценка 918 ₽, факт 945 ₽ -> доплата 27 ₽
    cur = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(cur).toMatchObject({ status: 'DONE', reservedMinor: 0n, diffMinor: -2_700n });
    expect(await balanceOf(db, cur.clientId)).toBe(400_900n);
    expect(await ledger()).toEqual([
      ['TOPUP', 500_000n],
      ['ORDER_RESERVE', -96_400n],
      ['ORDER_RELEASE', 96_400n],
      ['ORDER_CHARGE', -96_400n],
      ['DIFF_ADJUST', -2_700n],
    ]);
  });

  it('BALANCE with shortfall: partial reserve, top-up by transfer, payment confirmed, reject releases everything', async () => {
    await onboard();
    await topUp('500');
    const o = await newOrder('BALANCE');
    await quote(o.id);

    await click(CLIENT, `o:${o.id}:${await orderVersion(o.id)}:cf`);
    expect(lastTo(CLIENT)!.text).toMatch(/не хватает/);
    await click(CLIENT, 'w:short:ok');
    let cur = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(cur).toMatchObject({
      status: 'AWAITING_PAYMENT',
      reservedMinor: 50_000n,
      payDueMinor: 46_400n,
      payMethodId: null,
    });
    expect(lastTo(CLIENT)!.text).toMatch(/464 ₽/); // ждём реквизиты на доплату, а не на весь итог
    await requisites(o.id, 1);
    expect(allTo(CLIENT)).toMatch(/К оплате: <b>464 ₽<\/b>/);

    await click(CLIENT, `o:${o.id}:${await orderVersion(o.id)}:pd`);
    await photo(CLIENT);
    await click(ADMIN, `o:${o.id}:${await orderVersion(o.id)}:pc`);
    cur = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(cur).toMatchObject({ status: 'IN_PROGRESS', reservedMinor: 96_400n });
    expect(await balanceOf(db, cur.clientId)).toBe(0n);

    await click(ADMIN, `o:${o.id}:${await orderVersion(o.id)}:rj`);
    await say(ADMIN, 'Не получилось оплатить');
    cur = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(cur).toMatchObject({ status: 'REJECTED', reservedMinor: 0n });
    expect(await balanceOf(db, cur.clientId)).toBe(96_400n); // все деньги вернулись на баланс клиента
  });

  it('cancel and expiry release a partial reserve', async () => {
    await onboard();
    await topUp('500');
    const run = async () => {
      const o = await newOrder('BALANCE');
      await quote(o.id);
      await click(CLIENT, `o:${o.id}:${await orderVersion(o.id)}:cf`);
      await click(CLIENT, 'w:short:ok');
      return o.id;
    };
    const client = await db.user.findFirstOrThrow({ where: { role: 'CLIENT' } });

    const a = await run();
    expect(await balanceOf(db, client.id)).toBe(0n);
    await click(CLIENT, `o:${a}:${await orderVersion(a)}:cx`);
    expect((await db.order.findUniqueOrThrow({ where: { id: a } })).status).toBe('CANCELED');
    expect(await balanceOf(db, client.id)).toBe(50_000n);

    const b = await run();
    await db.order.update({ where: { id: b }, data: { quoteExpiresAt: new Date(Date.now() - 1000) } });
    expect(await deps.orders.expireDue()).toHaveLength(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: b } })).status).toBe('EXPIRED');
    expect(await balanceOf(db, client.id)).toBe(50_000n);
  });

  it('parallel confirmations never spend the same balance twice', async () => {
    const client = await onboard();
    await topUp('1000');
    const mk = async () => {
      const o = await deps.orders.create({
        clientId: client.id,
        type: 'OTHER',
        service: 'S',
        amountMinor: 1000n,
        currency: 'USD',
        isSubscription: false,
        payMode: 'BALANCE',
      });
      return deps.orders.quote(o.id, o.version, ADMIN_ACTOR(1));
    };
    const [o1, o2] = [await mk(), await mk()];
    const res = await Promise.all([
      deps.orders.confirmQuote(o1.id, o1.version, client.id, 1),
      deps.orders.confirmQuote(o2.id, o2.version, client.id, 1),
    ]);
    expect(res.map((r) => r.order.status).sort()).toEqual(['AWAITING_PAYMENT', 'IN_PROGRESS']);
    expect(await balanceOf(db, client.id)).toBe(0n); // 1000 ₽ ровно разделились; в минус не ушли
    expect((await db.ledgerEntry.findMany()).every((e) => e.type !== 'ORDER_RESERVE' || e.amountMinor < 0n)).toBe(true);
    expect(sumEntries(await db.ledgerEntry.findMany())).toBe(0n);
  });

  it('PAY_LATER: needs admin switch, respects the limit, creates a debt, repaid by top-up; reminders deduplicated', async () => {
    const client = await onboard();
    // без включения опции режима в диалоге нет — шаг пропускается, заявка идёт как PREPAY
    const plain = await newOrder();
    expect(plain.payMode).toBe('PREPAY');
    await click(CLIENT, `o:${plain.id}:1:cx`);

    await say(ADMIN, `/paylater ${client.id} on 1000`);
    expect(await db.user.findUniqueOrThrow({ where: { id: client.id } })).toMatchObject({
      payLaterEnabled: true,
      payLaterLimitMinor: 100_000n,
    });

    const o1 = await newOrder('PAY_LATER');
    await quote(o1.id);
    await click(CLIENT, `o:${o1.id}:${await orderVersion(o1.id)}:cf`);
    expect((await db.order.findUniqueOrThrow({ where: { id: o1.id } })).status).toBe('IN_PROGRESS');
    expect(await db.ledgerEntry.count()).toBe(0); // долга ещё нет — он появится при выполнении

    await finish(o1.id, '10'); // оценка 918 ₽, факт 900 ₽ -> переплата 18 ₽ в пользу клиента
    expect(await ledger()).toEqual([
      ['DEBT_OPEN', -96_400n],
      ['DIFF_ADJUST', 1_800n],
    ]);
    expect(await balanceOf(db, client.id)).toBe(-94_600n);
    expect(allTo(CLIENT)).toMatch(/Долг: <b>946 ₽<\/b>/);

    // второй заказ в долг: лимит 1000 ₽ превышен (946 + 964)
    const o2 = await newOrder('PAY_LATER');
    await quote(o2.id);
    await click(CLIENT, `o:${o2.id}:${await orderVersion(o2.id)}:cf`);
    expect((await db.order.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe('QUOTED');
    expect(lastTo(CLIENT)!.text).toMatch(/Превышен лимит/);

    await say(ADMIN, '/debts');
    expect(lastTo(ADMIN)!.text).toMatch(/Должны мне/);
    expect(lastTo(ADMIN)!.text).toMatch(/946 ₽/);

    // напоминание: не раньше reminderHour (10:00 МСК), один раз за период
    expect(await sendDebtReminders(deps, new Date('2026-10-09T05:00:00Z'))).toBe(0); // 08:00 МСК
    expect(await sendDebtReminders(deps, new Date('2026-10-09T08:00:00Z'))).toBe(1); // 11:00 МСК
    expect(await sendDebtReminders(deps, new Date('2026-10-09T09:00:00Z'))).toBe(0);
    expect(allTo(CLIENT)).toMatch(/Напоминание: за тобой долг/);

    // погашение: кнопка «Погасить долг» из напоминания
    await click(CLIENT, 'b:debt');
    const t = await db.topUp.findFirstOrThrow();
    expect(t.amountMinor).toBe(94_600n);
    await click(ADMIN, `p:${t.id}:1`);
    await say(ADMIN, 'Реквизиты для погашения');
    await click(CLIENT, `b:rc:${t.id}`);
    await photo(CLIENT);
    await click(ADMIN, `t:${t.id}:ok`);
    expect(await balanceOf(db, client.id)).toBe(0n);
    expect((await ledger()).slice(-1)).toEqual([['DEBT_REPAY', 94_600n]]);
    await say(ADMIN, '/debts');
    expect(lastTo(ADMIN)!.text).toMatch(/нет/i);
  });

  it('PAY_LATER is refused for clients without the switch even via a stale/forged order', async () => {
    const client = await onboard();
    const o = await deps.orders.create({
      clientId: client.id,
      type: 'OTHER',
      service: 'S',
      amountMinor: 1000n,
      currency: 'USD',
      isSubscription: false,
      payMode: 'PAY_LATER',
    });
    const q = await deps.orders.quote(o.id, o.version, ADMIN_ACTOR(1));
    await click(CLIENT, `o:${o.id}:${q.version}:cf`);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('QUOTED');
    expect(lastTo(CLIENT)!.text).toMatch(/не включена/);
  });

  it('admin: manual adjustment, client card, statuses in /clients; clients cannot use them', async () => {
    const client = await onboard();
    await say(ADMIN, `/adjust ${client.id} +500 бонус`);
    await say(ADMIN, `/adjust ${client.id} -150,50 возврат за подписку`);
    expect(await ledger()).toEqual([
      ['MANUAL_ADJUST', 50_000n],
      ['MANUAL_ADJUST', -15_050n],
    ]);
    expect(allTo(CLIENT)).toMatch(/скорректировал баланс/);

    await say(ADMIN, `/client ${client.id}`);
    expect(lastTo(ADMIN)!.text).toMatch(/Баланс: <b>349,50 ₽|Баланс: <b>349[, ]50/);
    await say(ADMIN, '/clients');
    expect(lastTo(ADMIN)!.text).toMatch(/баланс 349/);

    await say(CLIENT, `/adjust ${client.id} +100000`);
    await say(CLIENT, '/debts');
    expect(await db.ledgerEntry.count()).toBe(2);
    expect(lastTo(CLIENT)!.text).toMatch(/только администратору/);
  });

  it('balance mode is hidden when the balance is empty (only transfer is offered)', async () => {
    await onboard();
    const o = await newOrder(); // paymode-шага нет
    expect(o.payMode).toBe('PREPAY');
  });
});
