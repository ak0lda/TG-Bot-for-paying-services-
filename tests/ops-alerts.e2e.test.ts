import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { buildSignedInitData } from '../src/http/api/webapp-auth.js';
import { runHealthChecks } from '../src/services/scheduler.js';
import { ADMIN, BOT_TOKEN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('operational alerts to the admin', () => {
  const backupDir = mkdtempSync(join(tmpdir(), 'backups-'));
  const h = url ? createHarness(url, { BACKUP_DIR: backupDir, BACKUP_MAX_AGE_HOURS: '36' }) : (undefined as never);
  const { db, deps, say, lastTo, allTo, onboard } = h ?? ({} as typeof h);
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createHttpServer({ deps: h.deps, bot: h.bot });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await h.reset();
    // сбрасываем паузы между повторами оповещений
    (deps.alerts as unknown as { lastSent: Map<string, number> }).lastSent.clear();
  });

  const nowSec = () => Math.floor(Date.now() / 1000);
  const hb = (name: string, content: string) => writeFileSync(join(backupDir, name), content);
  const clearHb = () => {
    for (const n of ['.last_success', '.last_failure']) writeFileSync(join(backupDir, n), '');
  };

  it('an unexpected handler error: client sees a neutral message, admin gets a PII-free alert once per cooldown', async () => {
    await onboard();
    const spy = vi.spyOn(deps.orders, 'listForClient').mockRejectedValue(
      Object.assign(new Error('Invalid `prisma.order.findMany()`: { comment: "пароль клиента" }'), { name: 'PrismaClientKnownRequestError', code: 'P2025' }),
    );
    h.sent.length = 0;
    // handleUpdate пробрасывает ошибку наружу; в polling/webhook её перехватывает bot.catch — делаем то же.
    const say2 = async (text: string) => {
      try {
        await say(CLIENT, text);
      } catch (e) {
        await h.bot.errorHandler(e as never);
      }
    };
    await say2('📋 Мои заявки');
    await say2('📋 Мои заявки');
    spy.mockRestore();

    expect(allTo(CLIENT)).toMatch(/Что-то пошло не так/);
    const alerts = h.sent.filter((s) => s.chat === ADMIN && /Ошибка в обработчике/.test(s.text));
    expect(alerts).toHaveLength(1); // второй раз тот же сбой — пауза
    expect(alerts[0]!.text).toContain('PrismaClientKnownRequestError P2025');
    expect(alerts[0]!.text).not.toMatch(/пароль клиента/);
  });

  it('Mini App API 500: generic response, alert with the route and without error text', async () => {
    await onboard();
    const spy = vi.spyOn(deps.orders, 'listForClient').mockRejectedValue(new Error('db exploded with client data: секрет'));
    h.sent.length = 0;
    const res = await app.inject({ method: 'GET', url: '/api/orders', headers: { authorization: `tma ${buildSignedInitData({ id: CLIENT, first_name: 'U' }, BOT_TOKEN)}` } });
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'Внутренняя ошибка' });
    const alert = h.sent.find((s) => s.chat === ADMIN && /Ошибка Mini App API/.test(s.text))!;
    expect(alert.text).toContain('GET /api/orders');
    expect(alert.text).toContain('db exploded with client data'); // обычный Error: сообщение нашего же кода остаётся (оно задаётся разработчиком)
  });

  it('backup health: failed / stale / missing (only after the grace period) / ok, each alerted once per cooldown', async () => {
    const started = new Date();
    const run = async (at = new Date()) => {
      h.sent.length = 0;
      await runHealthChecks(deps, started, at);
      return allTo(ADMIN);
    };

    clearHb();
    expect(await run()).not.toMatch(/бэкап/i); // только что запустились — первого бэкапа ещё нет, это нормально
    (deps.alerts as unknown as { lastSent: Map<string, number> }).lastSent.clear();
    expect(await run(new Date(started.getTime() + 37 * 3_600_000))).toMatch(/Бэкапов БД нет уже более 36 ч/);

    hb('.last_success', `${nowSec() - 40 * 3600} file`);
    (deps.alerts as unknown as { lastSent: Map<string, number> }).lastSent.clear();
    expect(await run()).toMatch(/Последний успешный бэкап БД был 40 ч назад/);
    expect(await run()).toBe(''); // пауза

    hb('.last_failure', `${nowSec()} pg_dump: could not connect`);
    expect(await run()).toMatch(/завершился ошибкой.*pg_dump: could not connect/);

    hb('.last_success', `${nowSec() + 5} file`); // новый успех перекрывает неудачу
    (deps.alerts as unknown as { lastSent: Map<string, number> }).lastSent.clear();
    expect(await run()).not.toMatch(/бэкап/i);
  });

  it('stale CBR rates alert the admin (CBR down, saved snapshot is old)', async () => {
    // последний известный снимок — 10 часов назад, ЦБ недоступен
    const old = new Date(Date.now() - 10 * 3_600_000).toISOString();
    await db.setting.upsert({ where: { key: 'rateSeen' }, create: { key: 'rateSeen', value: { at: old, rates: { USD: '9000000000' } } }, update: { value: { at: old, rates: { USD: '9000000000' } } } });
    const { RatesService } = await import('../src/services/rates.js');
    const failing = new RatesService(db, deps.log, async () => { throw new Error('cbr down'); }, undefined, deps.settings);
    const sent: string[] = [];
    const fakeDeps = { ...deps, rates: failing, config: { ...deps.config, BACKUP_DIR: undefined }, alerts: { alert: async (_k: string, t: string) => (sent.push(t), true), error: async () => true } } as never;
    await runHealthChecks(fakeDeps, new Date());
    expect(sent.join()).toMatch(/Курс ЦБ не обновлялся 10 ч/);
    void lastTo;
  });
});
