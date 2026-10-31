import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../src/services/scheduler.js';
import { ADMIN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;
const CLIENT2 = 2001;
const HB = 'https://hc-ping.com/test-secret-token';

describe.skipIf(!url)('repeated receipts and the external heartbeat', () => {
  const h = url ? createHarness(url, { HEARTBEAT_URL: HB }) : (undefined as never);
  const { db, deps, say, photo, click, allTo, onboard, orderVersion, requisites } = h ?? ({} as typeof h);
  afterAll(async () => db.$disconnect());
  beforeEach(() => h.reset());

  async function registerSecondClient() {
    await say(ADMIN, '/invite второй');
    const code = /start=([\w-]+)/.exec(h.lastTo(ADMIN)!.text)![1]!;
    await say(CLIENT2, `/start ${code}`);
  }

  /** Клиент `tg` создаёт заявку, админ присылает реквизиты, клиент платит и прикладывает чек с file_unique_id = `uniq`. */
  async function payWithReceipt(tg: number, uniq: string) {
    await say(tg, '➕ Новая заявка');
    await click(tg, 'w:type:PAYMENT_LINK');
    await say(tg, 'https://checkout.stripe.com/c/pay/abc');
    await say(tg, 'Netflix');
    await say(tg, 'Premium');
    await say(tg, '10 USD');
    await click(tg, 'w:period:ONE');
    await click(tg, 'w:comment:skip');
    await click(tg, 'w:confirm:send');
    const o = await db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
    await click(ADMIN, `o:${o.id}:1:q`);
    await click(tg, `o:${o.id}:2:cf`);
    await requisites(o.id, 1);
    await click(tg, `o:${o.id}:${await orderVersion(o.id)}:pd`);
    h.sent.length = 0;
    await photo(tg, uniq);
    return o.id;
  }

  it('warns the admin when the same receipt file is attached to another order, flags a different client, ignores fresh files', async () => {
    await onboard();
    await registerSecondClient();

    const first = await payWithReceipt(CLIENT, 'RCPT-A');
    expect(allTo(ADMIN)).not.toMatch(/уже прикладывали/); // первый раз — всё чисто
    expect((await db.attachment.findFirstOrThrow({ where: { orderId: first } })).tgFileUniqueId).toBe('RCPT-A');

    const second = await payWithReceipt(CLIENT, 'RCPT-B'); // новый файл
    expect(allTo(ADMIN)).not.toMatch(/уже прикладывали/);
    expect(second).not.toBe(first);

    const reuseSame = await payWithReceipt(CLIENT, 'RCPT-A'); // тот же клиент, тот же файл
    expect(allTo(ADMIN)).toMatch(new RegExp(`уже прикладывали раньше[\\s\\S]*заявка #${first}`));
    expect(allTo(ADMIN)).not.toMatch(/другой клиент/);

    const reuseOther = await payWithReceipt(CLIENT2, 'RCPT-A'); // чужой чек — самый подозрительный случай
    expect(allTo(ADMIN)).toMatch(/другой клиент!/);
    expect(allTo(ADMIN)).toContain(`#${first}`);
    expect(allTo(ADMIN)).toContain(`#${reuseSame}`);
    expect(reuseOther).toBeGreaterThan(reuseSame);
  });

  it('also catches a receipt reused on a top-up; re-sending the same file to the SAME order is not flagged', async () => {
    await onboard();
    const orderId = await payWithReceipt(CLIENT, 'RCPT-T');

    // «оплата не найдена» -> клиент снова присылает тот же файл к той же заявке: не повтор
    await click(ADMIN, `o:${orderId}:${await orderVersion(orderId)}:pn`);
    await click(CLIENT, `o:${orderId}:${await orderVersion(orderId)}:pd`);
    h.sent.length = 0;
    await photo(CLIENT, 'RCPT-T');
    expect(allTo(ADMIN)).not.toMatch(/уже прикладывали/);

    // тот же файл как чек пополнения
    await say(CLIENT, '➕ Пополнить баланс');
    await say(CLIENT, '1000');
    const t = await db.topUp.findFirstOrThrow();
    await click(ADMIN, `p:${t.id}:1`);
    await say(ADMIN, 'Реквизиты');
    await click(CLIENT, `b:rc:${t.id}`);
    h.sent.length = 0;
    await photo(CLIENT, 'RCPT-T');
    expect(allTo(ADMIN)).toMatch(new RegExp(`уже прикладывали раньше[\\s\\S]*заявка #${orderId}`));
  });

  describe('external heartbeat', () => {
    it('pings after a successful scheduler pass, and stays silent when the pass fails (dead-man switch)', async () => {
      const pings: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (u: string) => (pings.push(String(u)), new Response('OK'))),
      );
      try {
        const stop = startScheduler(deps);
        await vi.waitFor(() => expect(pings).toEqual([HB]), { timeout: 5000 });
        stop();

        pings.length = 0;
        const spy = vi.spyOn(deps.orders, 'expireDue').mockRejectedValueOnce(new Error('boom'));
        const stop2 = startScheduler(deps);
        await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 300));
        stop2();
        expect(pings).toEqual([]); // сбой прохода — пульса нет, мониторинг сработает
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
