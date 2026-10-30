import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { buildSignedInitData } from '../src/http/api/webapp-auth.js';
import { RatesService, type RateAnomaly } from '../src/services/rates.js';
import { ADMIN, BOT_TOKEN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;

const xml = (usd: string, jpy = '0,6000') => `<ValCurs>
<Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>${usd}</Value></Valute>
<Valute><CharCode>JPY</CharCode><Nominal>1</Nominal><Value>${jpy}</Value></Valute>
</ValCurs>`;

describe.skipIf(!url)('exchange-rate warnings before quoting', () => {
  const h = url ? createHarness(url) : (undefined as never);
  const { db, deps, say, click, lastTo, allTo, onboard } = h ?? ({} as typeof h);
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createHttpServer({ deps: h.deps, bot: h.bot });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });
  beforeEach(() => h.reset());

  // ── Сервис курсов: скачки, снимок, устаревание ──────────────
  describe('RatesService', () => {
    let now: Date;
    const mkService = (fetchXml: () => Promise<string>) => new RatesService(db, deps.log, fetchXml, () => now, deps.settings);

    it('detects a jump between hourly refreshes, alerts only for relevant currencies, and acknowledgement silences it', async () => {
      now = new Date('2026-10-30T10:00:00Z');
      let body = xml('90,0000');
      const svc = mkService(async () => body);
      const anomalies: RateAnomaly[] = [];
      svc.setAnomalyHandler((a) => anomalies.push(a));

      expect((await svc.assess('USD')).warnings).toEqual([]);
      expect(await db.setting.findUnique({ where: { key: 'rateSeen' } })).not.toBeNull();

      now = new Date('2026-10-30T11:30:00Z'); // кеш (1 ч) истёк
      body = xml('95,4000', '0,9000'); // USD +6%, JPY +50%
      const a = await svc.assess('USD');
      expect(a.warnings).toMatchObject([{ kind: 'jump', changeBp: 600 }]);
      expect(anomalies.map((x) => x.currency)).toEqual(['USD']); // JPY — не наша валюта: без оповещения
      expect(await db.setting.findUnique({ where: { key: 'rateJump:JPY' } })).not.toBeNull(); // но пометка записана

      await svc.acknowledge('USD');
      expect((await svc.assess('USD')).warnings).toEqual([]);

      now = new Date('2026-10-31T13:00:00Z'); // >24 ч: скачок уже не актуален
      body = xml('95,5000');
      expect((await svc.assess('USD')).warnings).toEqual([]);
    });

    it('small moves do not warn; the threshold is a setting', async () => {
      now = new Date('2026-10-30T10:00:00Z');
      let body = xml('90,0000');
      const svc = mkService(async () => body);
      await svc.assess('USD');
      now = new Date('2026-10-30T11:30:00Z');
      body = xml('93,0000'); // +3,3%
      expect((await svc.assess('USD')).warnings).toEqual([]);
      await say(ADMIN, '/start');
      await say(ADMIN, '/settings rateJumpBp 2');
      now = new Date('2026-10-30T13:00:00Z');
      body = xml('96,0000'); // +3,2% — теперь выше порога 2%
      expect((await svc.assess('USD')).warnings).toMatchObject([{ kind: 'jump' }]);
    });

    it('after a restart with CBR down it falls back to the saved snapshot and says the rates are stale; CBR is not hammered', async () => {
      now = new Date('2026-10-30T10:00:00Z');
      await mkService(async () => xml('90,0000')).assess('USD'); // снимок сохранён

      now = new Date('2026-10-30T18:00:00Z'); // 8 часов спустя, «после перезапуска»
      const failing = vi.fn(async () => {
        throw new Error('CBR down');
      });
      const svc = mkService(failing);
      const a = await svc.assess('USD');
      expect(a.rate.scaled).toBe(9_000_000_000n);
      expect(a.warnings).toEqual([{ kind: 'stale', ageHours: 8 }]);
      expect(await svc.cbrAgeHours()).toBe(8);
      await svc.assess('USD');
      await svc.assess('EUR').catch(() => undefined);
      expect(failing).toHaveBeenCalledTimes(1); // повтор не чаще раза в минуту

      now = new Date('2026-10-30T18:02:00Z');
      await svc.assess('USD');
      expect(failing).toHaveBeenCalledTimes(2);
    });

    it('old or diverging manual rate warns; RUB never does', async () => {
      now = new Date();
      const svc = mkService(async () => xml('90,0000'));
      await svc.setManual('USD', '100'); // CBR 90 -> +11%
      expect((await svc.assess('USD')).warnings).toMatchObject([{ kind: 'manual_diverged' }]);
      await db.$executeRawUnsafe(`UPDATE "Setting" SET "updatedAt" = now() - interval '5 days' WHERE key = 'manualRate:USD'`);
      expect((await svc.assess('USD')).warnings.map((w) => w.kind)).toEqual(['manual_old', 'manual_diverged']);
      expect((await svc.assess('RUB')).warnings).toEqual([]);
    });
  });

  // ── Бот и API: расчёт спрашивает подтверждение ───────────────
  async function newOrder() {
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, 'https://checkout.stripe.com/c/pay/abc');
    await say(CLIENT, 'Netflix');
    await say(CLIENT, 'Premium');
    await say(CLIENT, '10 USD');
    await click(CLIENT, 'w:period:ONE');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    return db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
  }
  const makeManualRateOld = () =>
    db.$executeRawUnsafe(`UPDATE "Setting" SET "updatedAt" = now() - interval '5 days' WHERE key = 'manualRate:USD'`);

  it('bot: admin must confirm quoting at a doubtful rate; the confirmation silences repeats for an hour', async () => {
    await onboard();
    await makeManualRateOld();
    const o1 = await newOrder();
    h.sent.length = 0;
    await click(ADMIN, `o:${o1.id}:1:q`);
    expect(lastTo(ADMIN)!.text).toMatch(/Ручной курс USD \(90,00 ₽\) задан 5 дн\. назад/);
    expect(h.cbData(lastTo(ADMIN))).toEqual([`o:${o1.id}:1:qf`, `o:${o1.id}:1:v`]);
    expect((await db.order.findUniqueOrThrow({ where: { id: o1.id } })).status).toBe('NEW'); // не рассчитано

    await click(ADMIN, `o:${o1.id}:1:qf`);
    expect((await db.order.findUniqueOrThrow({ where: { id: o1.id } })).status).toBe('QUOTED');
    expect(allTo(CLIENT)).toMatch(/рассчитана/);

    const o2 = await newOrder(); // в течение часа не переспрашиваем
    await click(ADMIN, `o:${o2.id}:1:q`);
    expect((await db.order.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe('QUOTED');

    // клиент не может подделать «рассчитать всё равно»
    const o3 = await newOrder();
    await click(CLIENT, `o:${o3.id}:1:qf`);
    expect((await db.order.findUniqueOrThrow({ where: { id: o3.id } })).status).toBe('NEW');
  });

  it('API: 409 rate_warning with texts unless force=true', async () => {
    await onboard();
    await makeManualRateOld();
    const o = await newOrder();
    const call = async (path: string, body: unknown) => {
      const r = await app.inject({ method: 'POST', url: `/api${path}`, headers: { authorization: `tma ${buildSignedInitData({ id: ADMIN, first_name: 'A' }, BOT_TOKEN)}` }, payload: body as object });
      return { status: r.statusCode, json: r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const blocked = await call(`/admin/orders/${o.id}/quote`, { version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.json).toMatchObject({ error: 'rate_warning', currency: 'USD', warnings: [{ kind: 'manual_old' }] });
    expect(blocked.json.warnings[0].text).toMatch(/Ручной курс USD/);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('NEW');

    const ok = await call(`/admin/orders/${o.id}/quote`, { version: 1, force: true });
    expect(ok.status).toBe(200);
    expect(ok.json.order.status).toBe('QUOTED');
  });
});
