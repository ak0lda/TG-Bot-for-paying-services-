import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { buildSignedInitData } from '../src/http/api/webapp-auth.js';
import { ADMIN, BOT_TOKEN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('/fx — buffer advice from real settlement differences', () => {
  const h = url ? createHarness(url) : (undefined as never);
  const { db, deps, say, click, lastTo, onboard } = h ?? ({} as typeof h);
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createHttpServer({ deps: h.deps, bot: h.bot });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });
  beforeEach(() => h.reset());

  /**
   * Вставляет выполненные заявки (10 USD по курсу 90, запас 2% — оценка 918 ₽) с заданным проскальзыванием в б.п.
   * относительно чистой конвертации 900 ₽: расход = 900 ₽ × (1 + slip/10000), разница по факту = 918 ₽ − расход.
   */
  async function seedDone(clientId: number, slips: number[], opts: { daysAgo?: number; currency?: string } = {}) {
    for (const slip of slips) {
      const actualKop = 90_000n + BigInt(slip) * 9n; // 90 000 коп. × slip / 10 000
      const o = await db.order.create({
        data: {
          clientId,
          type: 'OTHER',
          service: 'S',
          status: 'DONE',
          amountMinor: 1000n,
          currency: 'USD',
          rate: '90.00000000',
          fxBufferBp: 200,
          markupBp: 500,
          fixedFeeMinor: 0n,
          totalMinor: 96_400n,
          diffMinor: 91_800n - actualKop,
          actualChargeMinor: 1000n,
          actualCurrency: opts.currency ?? 'USD',
        },
      });
      await db.orderEvent.create({
        data: {
          orderId: o.id,
          toStatus: 'DONE',
          fromStatus: 'IN_PROGRESS',
          createdAt: new Date(Date.now() - (opts.daysAgo ?? 1) * 86_400_000),
        },
      });
    }
  }
  const SLIPS = [10, 20, 25, 30, 30, 35, 40, 40, 45, 45, 50, 50, 55, 55, 60, 60, 65, 70, 150, 240];

  it('too little data: no recommendation, no apply button', async () => {
    const client = await onboard();
    await seedDone(client.id, [10, 20, 30]);
    await say(ADMIN, '/fx');
    expect(lastTo(ADMIN)!.text).toMatch(/Данных пока мало/);
    expect(h.cbData(lastTo(ADMIN))).toEqual([]);
  });

  it('computes surcharge share, quantiles and recommendation; one tap applies it; only the admin can', async () => {
    const client = await onboard();
    await seedDone(client.id, SLIPS);
    await say(ADMIN, '/fx');
    const text = lastTo(ADMIN)!.text;
    expect(text).toMatch(/выполнено заявок: 20/);
    expect(text).toMatch(/Сейчас запас: <b>2%<\/b> — клиентам пришлось доплачивать в 5% заявок/);
    expect(text).toMatch(/медиана 0,45%, у 90% заявок не выше 0,7%, максимум 2,4%/);
    expect(text).toMatch(/Рекомендация: <b>0,7%<\/b> — доплата понадобится примерно в 10% заявок/);
    expect(text).toMatch(/не меняет вашу прибыль/);
    expect(h.cbData(lastTo(ADMIN))).toEqual(['fx:70']);

    await click(CLIENT, 'fx:70'); // клиент не может менять настройки
    expect((await deps.settings.getAll()).fxBufferBp).toBe(200);
    expect(h.alerts()).toContain('Нет доступа.');

    await click(ADMIN, 'fx:70');
    expect((await deps.settings.getAll()).fxBufferBp).toBe(70);
    expect(lastTo(ADMIN)!.text).toMatch(/Запас на конвертацию теперь 0,7%/);
    await click(ADMIN, 'fx:99999'); // мусор
    expect((await deps.settings.getAll()).fxBufferBp).toBe(70);

    await say(ADMIN, '/fx');
    expect(lastTo(ADMIN)!.text).toMatch(/Сейчас запас: <b>0,7%<\/b>/);
    expect(h.cbData(lastTo(ADMIN))).toEqual([]); // уже применено — кнопки нет
  });

  it('respects the period and validates the argument; groups by card currency', async () => {
    const client = await onboard();
    await seedDone(client.id, SLIPS);
    await seedDone(client.id, [500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400], {
      daysAgo: 100,
      currency: 'EUR',
    });
    await say(ADMIN, '/fx 60');
    expect(lastTo(ADMIN)!.text).toMatch(/выполнено заявок: 20/); // старые не учитываются
    expect(lastTo(ADMIN)!.text).not.toMatch(/По валюте карты/); // одна валюта — разбивки нет
    await say(ADMIN, '/fx 365');
    expect(lastTo(ADMIN)!.text).toMatch(/выполнено заявок: 30/);
    expect(lastTo(ADMIN)!.text).toMatch(/По валюте карты[\s\S]*USD: [\s\S]*\(20\)[\s\S]*EUR: [\s\S]*\(10\)/);
    for (const bad of ['/fx 3', '/fx 999', '/fx abc']) {
      await say(ADMIN, bad);
      expect(lastTo(ADMIN)!.text, bad).toMatch(/Использование: \/fx/);
    }
    await say(CLIENT, '/fx');
    expect(lastTo(CLIENT)!.text).toMatch(/только администратору/);
  });

  it('real flow: the settlement diff of a finished order feeds the advice (end to end)', async () => {
    await onboard();
    // заявка 10 USD, расход 10,50 USD по курсу 90 = 945 ₽ -> проскальзывание +5% (500 б.п.)
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, 'Netflix');
    await say(CLIENT, 'Premium');
    await say(CLIENT, '10 USD');
    await click(CLIENT, 'w:period:ONE');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    const o = await db.order.findFirstOrThrow();
    await click(ADMIN, `o:${o.id}:1:q`);
    await click(CLIENT, `o:${o.id}:2:cf`);
    await h.requisites(o.id, 1);
    await click(CLIENT, `o:${o.id}:3:pd`);
    await h.photo(CLIENT);
    await click(ADMIN, `o:${o.id}:4:pc`);
    await click(ADMIN, `o:${o.id}:5:dn`);
    await click(ADMIN, 'w:card:1');
    await say(ADMIN, '10,50');
    await click(ADMIN, 'w:rate:ok');
    await click(ADMIN, 'w:shot:skip');
    await click(ADMIN, 'w:confirm:ok');

    const samples = await deps.reports.fxSamples(30);
    expect(samples).toEqual([{ slipBp: 500, currency: 'USD' }]); // (945 − 900) / 900 = 5%
  });

  it('Mini App API: /admin/fx for admin only, with the same numbers', async () => {
    const client = await onboard();
    await seedDone(client.id, SLIPS);
    const call = async (id: number, path: string) => {
      const r = await app.inject({
        method: 'GET',
        url: `/api${path}`,
        headers: { authorization: `tma ${buildSignedInitData({ id, first_name: 'U' }, BOT_TOKEN)}` },
      });
      return { status: r.statusCode, json: r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    expect((await call(CLIENT, '/admin/fx')).status).toBe(403);
    const ok = await call(ADMIN, '/admin/fx?days=60');
    expect(ok.json).toMatchObject({
      days: 60,
      sample: 20,
      enough: true,
      currentBp: 200,
      medianBp: 45,
      p90Bp: 70,
      recommendedBp: 70,
    });
    expect((await call(ADMIN, '/admin/fx?days=2')).status).toBe(400);
  });
});
