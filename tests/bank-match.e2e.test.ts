import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('forwarded bank notifications -> suggested payment confirmation', () => {
  const h = url ? createHarness(url) : (undefined as never);
  const { db, deps, say, photo, click, lastTo, allTo, alerts, onboard, orderVersion, requisites } =
    h ?? ({} as typeof h);
  afterAll(async () => db.$disconnect());
  beforeEach(() => h.reset());

  /** Заявка на 10 USD (964 ₽); доводим до «реквизиты отправлены» (AWAITING_PAYMENT). */
  async function awaitingOrder(amount = '10 USD') {
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, 'Netflix');
    await say(CLIENT, 'Premium');
    await say(CLIENT, amount);
    await click(CLIENT, 'w:period:ONE');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    const o = await db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
    await click(ADMIN, `o:${o.id}:1:q`);
    await click(CLIENT, `o:${o.id}:2:cf`);
    await requisites(o.id, 1);
    h.sent.length = 0;
    return o.id;
  }
  const status = async (id: number) => (await db.order.findUniqueOrThrow({ where: { id } })).status;
  const ledger = async () =>
    (await db.ledgerEntry.findMany({ orderBy: { id: 'asc' } })).map((l) => [l.type, l.amountMinor]);

  it('one match: suggests, one tap confirms (even before the client pressed “I paid”), double tap is harmless', async () => {
    await onboard();
    const id = await awaitingOrder();
    await say(ADMIN, 'Поступление 964,00 RUB от ИВАН И. Баланс: 50 000,00 RUB MARKERBANK');
    const msg = lastTo(ADMIN)!;
    expect(msg.text).toMatch(/В уведомлении: <b>964 ₽<\/b>/);
    expect(msg.text).toMatch(new RegExp(`заявка #${id} — Netflix, клиент #\\d+ U2000`));
    const v = await orderVersion(id);
    expect(h.cbData(msg)).toEqual([`m:o:${id}:${v}`]);
    expect(await status(id)).toBe('AWAITING_PAYMENT'); // само по себе сообщение ничего не зачисляет
    expect(await db.ledgerEntry.count()).toBe(0);

    await click(ADMIN, `m:o:${id}:${v}`);
    expect(await status(id)).toBe('IN_PROGRESS');
    expect(await ledger()).toEqual([['PAYMENT_RECEIVED', 96_400n]]);
    expect(allTo(CLIENT)).toMatch(/Оплата по заявке #1 подтверждена/);
    expect(lastTo(ADMIN)!.text).toMatch(/Поступление подтверждено — заявка #1 в работе/);

    await click(ADMIN, `m:o:${id}:${v}`); // повторное нажатие
    expect(alerts()).toContain('Заявка уже изменилась — открой её заново: /orders');
    expect(await ledger()).toEqual([['PAYMENT_RECEIVED', 96_400n]]); // не задвоилось

    // текст уведомления не сохраняется нигде
    for (const t of ['Order', 'OrderEvent', 'TopUp', 'LedgerEntry', 'Attachment', 'Setting', 'Reminder']) {
      const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "${t}" x WHERE x::text LIKE '%MARKERBANK%'`,
      );
      expect(rows[0]!.n, t).toBe(0n);
    }
  });

  it('works for orders that the client already marked as paid (PAYMENT_CHECK)', async () => {
    await onboard();
    const id = await awaitingOrder();
    await click(CLIENT, `o:${id}:${await orderVersion(id)}:pd`);
    await photo(CLIENT);
    expect(await status(id)).toBe('PAYMENT_CHECK');
    await say(ADMIN, '+964 ₽ Перевод от Иван Иванович');
    await click(ADMIN, `m:o:${id}:${await orderVersion(id)}`);
    expect(await status(id)).toBe('IN_PROGRESS');
  });

  it('several obligations with the same amount: all offered, confirming one leaves the other', async () => {
    await onboard();
    const a = await awaitingOrder();
    const b = await awaitingOrder();
    await say(ADMIN, 'Зачислен перевод 964 ₽');
    const msg = lastTo(ADMIN)!;
    expect(msg.text).toMatch(/Подходит несколько/);
    expect(h.cbData(msg)).toEqual([`m:o:${a}:${await orderVersion(a)}`, `m:o:${b}:${await orderVersion(b)}`]); // старшая первой
    await click(ADMIN, h.cbData(msg)[0]!);
    expect([await status(a), await status(b)]).toEqual(['IN_PROGRESS', 'AWAITING_PAYMENT']);
  });

  it('top-up requests are matched too (existing confirm button)', async () => {
    await onboard();
    await say(CLIENT, '➕ Пополнить баланс');
    await say(CLIENT, '5000');
    const t = await db.topUp.findFirstOrThrow();
    await click(ADMIN, `p:${t.id}:1`);
    await say(ADMIN, 'Реквизиты');
    h.sent.length = 0;
    await say(ADMIN, 'Поступление 5 000,00 RUB');
    expect(lastTo(ADMIN)!.text).toMatch(/пополнение #1/);
    expect(h.cbData(lastTo(ADMIN))).toEqual([`t:${t.id}:ok`]);
    await click(ADMIN, `t:${t.id}:ok`);
    expect(await ledger()).toEqual([['TOPUP', 500_000n]]);
  });

  it('no exact match: nothing is changed, the waiting list is shown', async () => {
    await onboard();
    const id = await awaitingOrder();
    await say(ADMIN, 'Поступление 777 ₽');
    expect(lastTo(ADMIN)!.text).toMatch(/не нашёл/);
    expect(lastTo(ADMIN)!.text).toMatch(new RegExp(`заявка #${id} — Netflix — 964 ₽`));
    expect(h.cbData(lastTo(ADMIN))).toEqual([]);
    expect(await status(id)).toBe('AWAITING_PAYMENT');
    // обязательств нет вообще
    await click(ADMIN, `o:${id}:${await orderVersion(id)}:rj`);
    await say(ADMIN, 'Не нужно');
    await say(ADMIN, 'Поступление 777 ₽');
    expect(lastTo(ADMIN)!.text).toMatch(/никто не ждёт оплату/);
  });

  it('outgoing, non-rouble and ambiguous notifications are handled safely; plain text falls through', async () => {
    await onboard();
    const id = await awaitingOrder();
    await say(ADMIN, 'Списание 964,00 RUB. Остаток 100 RUB');
    expect(lastTo(ADMIN)!.text).toMatch(/Похоже на списание/);
    expect(h.cbData(lastTo(ADMIN))).toEqual([]);

    await say(ADMIN, 'Credited $100.00');
    expect(lastTo(ADMIN)!.text).toMatch(/не в рублях \(100 USD\)/);

    await say(ADMIN, '964 ₽');
    expect(lastTo(ADMIN)!.text).toMatch(/направление операции не распознал/);
    expect(h.cbData(lastTo(ADMIN))).toHaveLength(1); // всё равно только предложение

    await say(ADMIN, 'привет, бот');
    expect(lastTo(ADMIN)!.text).toMatch(/Не понял/);
    expect(await status(id)).toBe('AWAITING_PAYMENT');
    expect(await db.ledgerEntry.count()).toBe(0);
  });

  it('only the admin can use it; an active dialog has priority; requisites are required first', async () => {
    await onboard();
    const id = await awaitingOrder();
    h.sent.length = 0;
    await say(CLIENT, 'Поступление 964,00 RUB'); // клиент пересылает «уведомление»: игнорируется
    expect(lastTo(CLIENT)!.text).toMatch(/Не понял/);
    await click(CLIENT, `m:o:${id}:${await orderVersion(id)}`); // и кнопку нажать не может
    expect(alerts()).toContain('Нет доступа.');
    expect(await status(id)).toBe('AWAITING_PAYMENT');

    // пока админ вводит реквизиты в диалоге, сумма в тексте — часть реквизитов, а не уведомление банка
    await click(ADMIN, `r:${id}:${await orderVersion(id)}:2`);
    h.sent.length = 0;
    await say(ADMIN, 'Прямой перевод, сумма 964 ₽, +995 555 00 00 00');
    expect(allTo(ADMIN)).not.toMatch(/В уведомлении/);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).payMethodId).toBe(2);

    // заявка без отправленных реквизитов не предлагается и не подтверждается (в т.ч. подделанной кнопкой)
    const id2 = await (async () => {
      await say(CLIENT, '➕ Новая заявка');
      await click(CLIENT, 'w:type:PAYMENT_LINK');
      await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
      await say(CLIENT, 'Spotify');
      await say(CLIENT, 'Plan');
      await say(CLIENT, '20 USD');
      await click(CLIENT, 'w:period:ONE');
      await click(CLIENT, 'w:comment:skip');
      await click(CLIENT, 'w:confirm:send');
      const o = await db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
      await click(ADMIN, `o:${o.id}:1:q`);
      await click(CLIENT, `o:${o.id}:2:cf`);
      return o.id;
    })();
    await say(ADMIN, 'Поступление 1 928 ₽'); // сумма заявки без реквизитов
    expect(lastTo(ADMIN)!.text).toMatch(/не нашёл/);
    await click(ADMIN, `o:${id2}:${await orderVersion(id2)}:pc`);
    expect(await status(id2)).toBe('AWAITING_PAYMENT');
    expect(lastTo(ADMIN)!.text).toMatch(/ещё не прислал реквизиты|Реквизиты/);
    void deps;
  });
});
