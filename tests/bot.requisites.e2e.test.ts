import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;
const CLIENT2 = 2001;

describe.skipIf(!url)('admin-sent requisites (orders and top-ups)', () => {
  const h = url ? createHarness(url) : (undefined as never);
  const { db, say, photo, click, lastTo, allTo, alerts, onboard, orderVersion, requisites } = h ?? ({} as typeof h);
  afterAll(async () => db.$disconnect());
  beforeEach(() => h.reset());

  async function quotedOrder() {
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, 'Netflix');
    await say(CLIENT, 'Premium');
    await say(CLIENT, '10 USD');
    await click(CLIENT, 'w:period:ONE');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    const o = await db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
    await click(ADMIN, `o:${o.id}:1:q`);
    await click(CLIENT, `o:${o.id}:2:cf`);
    return o.id;
  }

  it('method with a saved text can be sent with one button; free text is validated; can be re-sent via another method', async () => {
    await onboard();
    await say(ADMIN, '/method_add Наличные в офисе | Тверская, 1, с 10 до 19 | нет');
    await say(ADMIN, '/method_add Только реквизиты | - | да');
    expect(lastTo(ADMIN)!.text).toMatch(/Способ добавлен/);
    await say(ADMIN, '/methods');
    expect(lastTo(ADMIN)!.text).toMatch(/Текст реквизитов: Тверская, 1/);
    expect(lastTo(ADMIN)!.text).toMatch(/Текста нет — реквизиты присылаешь вручную/);

    const id = await quotedOrder();
    // слишком короткий текст отклоняется, диалог остаётся
    const v = await orderVersion(id);
    await click(ADMIN, `r:${id}:${v}:1`);
    await say(ADMIN, 'ab');
    expect(lastTo(ADMIN)!.text).toMatch(/от 3 до 1000 символов/);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).payMethodId).toBeNull();
    await say(ADMIN, 'СБП +7 900 000-00-01');
    expect((await db.order.findUniqueOrThrow({ where: { id } })).payMethodId).toBe(1);

    // у способа с готовым текстом есть кнопка «Отправить сохранённый текст»
    await click(ADMIN, `r:${id}:${v}:4`);
    expect(h.cbData(lastTo(ADMIN))).toContain('w:text:saved');
    await click(ADMIN, 'w:text:saved');
    const o = await db.order.findUniqueOrThrow({ where: { id } });
    expect(o).toMatchObject({ payMethodId: 4, status: 'AWAITING_PAYMENT', version: v }); // версия не менялась — карточки не «протухают»
    expect(allTo(CLIENT)).toMatch(/Тверская, 1, с 10 до 19/);
    expect(await db.orderEvent.count({ where: { orderId: id, comment: { startsWith: 'Реквизиты отправлены' } } })).toBe(2);

    // «Я оплатил» для способа без чека — сразу на проверку
    await click(CLIENT, `o:${id}:${v}:pd`);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('PAYMENT_CHECK');
  });

  it('stale cards and wrong roles cannot send requisites', async () => {
    await onboard();
    const id = await quotedOrder();
    const v = await orderVersion(id);

    await click(CLIENT, `r:${id}:${v}:1`); // клиент не может
    expect(alerts()).toContain('Нет доступа.');
    expect(h.deps.wizards.has(CLIENT)).toBe(false);

    await click(CLIENT, `o:${id}:${v}:cx`); // заявку отменили -> карточка админа устарела
    h.sent.length = 0;
    await click(ADMIN, `r:${id}:${v}:1`);
    expect(alerts()).toContain('Карточка устарела — показываю актуальную.');
    expect(h.deps.wizards.has(ADMIN)).toBe(false);
    expect(allTo(CLIENT)).toBe(''); // клиенту ничего не ушло
    expect((await db.order.findUniqueOrThrow({ where: { id } })).payMethodId).toBeNull();

    await click(ADMIN, `r:${id}:${v}:99`); // неизвестный способ
    expect(h.deps.wizards.has(ADMIN)).toBe(false);
  });

  it('top-up: admin picks the method and sends requisites, client sends the receipt only after that; foreign/processed top-ups are refused', async () => {
    await onboard();
    await say(ADMIN, '/invite второй');
    const code = /start=([\w-]+)/.exec(lastTo(ADMIN)!.text)![1]!;
    await say(CLIENT2, `/start ${code}`);

    await say(CLIENT, '➕ Пополнить баланс');
    await say(CLIENT, '6000');
    expect(lastTo(CLIENT)!.text).toMatch(/пришлёт реквизиты/);
    const t = await db.topUp.findFirstOrThrow();
    expect(t).toMatchObject({ methodId: null, status: 'PENDING', amountMinor: 600_000n });
    const card = lastTo(ADMIN)!;
    expect(card.text).toMatch(/Реквизиты не отправлены/);
    expect(h.cbData(card)).toEqual([`p:${t.id}:1`, `p:${t.id}:2`, `p:${t.id}:3`, `t:${t.id}:ok`, `t:${t.id}:no`]);

    // чек до реквизитов не принимается (кнопки нет, а подделка не открывает диалог)
    await click(CLIENT, `b:rc:${t.id}`);
    expect(h.deps.wizards.has(CLIENT)).toBe(false);
    expect(alerts()).toContain('Админ ещё не прислал реквизиты — дождись сообщения от бота, потом нажми «Я оплатил».');

    await click(ADMIN, `p:${t.id}:2`);
    await say(ADMIN, 'Прямой перевод: +995 555 00 00 00, Example Bank, IVAN IVANOV');
    expect(allTo(CLIENT)).toMatch(/Example Bank/);
    expect(h.cbData(h.lastTo(CLIENT))).toEqual([`b:rc:${t.id}`]);
    expect((await db.topUp.findUniqueOrThrow({ where: { id: t.id } })).methodId).toBe(2);

    // чужой клиент не может присылать чек по чужому пополнению
    await click(CLIENT2, `b:rc:${t.id}`);
    expect(h.deps.wizards.has(CLIENT2)).toBe(false);
    expect(alerts()).toContain('Это пополнение уже обработано.');

    await click(CLIENT, `b:rc:${t.id}`);
    await say(CLIENT, 'вот чек');
    expect(lastTo(CLIENT)!.text).toMatch(/фото или файл/);
    await photo(CLIENT);
    expect(await db.attachment.count({ where: { topUpId: t.id } })).toBe(1);
    expect(h.sent.some((s) => s.method === 'sendPhoto' && s.chat === ADMIN)).toBe(true);
    expect(allTo(ADMIN)).toMatch(/Чеков от клиента: 1/);

    await click(ADMIN, `t:${t.id}:ok`);
    expect(await db.ledgerEntry.count()).toBe(1);

    // после обработки ни реквизиты, ни чек больше не принимаются
    h.sent.length = 0;
    await click(ADMIN, `p:${t.id}:1`);
    expect(alerts()).toContain('Уже обработано.');
    expect(h.deps.wizards.has(ADMIN)).toBe(false);
    await click(CLIENT, `b:rc:${t.id}`);
    expect(h.deps.wizards.has(CLIENT)).toBe(false);
  });

  it('cash-like method without receipt: top-up has no receipt button and admin confirms manually', async () => {
    await onboard();
    await say(CLIENT, '➕ Пополнить баланс');
    await say(CLIENT, '1000');
    const t = await db.topUp.findFirstOrThrow();
    await click(ADMIN, `p:${t.id}:3`); // «Наличные» — чек не нужен
    await say(ADMIN, 'Передам лично');
    expect(h.cbData(h.lastTo(CLIENT))).toEqual([]);
    expect(allTo(CLIENT)).toMatch(/подтвердит поступление вручную/);
    await click(ADMIN, `t:${t.id}:ok`);
    expect(await db.ledgerEntry.count()).toBe(1);
  });
});
