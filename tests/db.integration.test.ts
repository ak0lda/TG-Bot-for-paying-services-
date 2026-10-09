import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { bootstrapDefaults } from '../src/db/bootstrap.js';
import { InviteService } from '../src/services/invite-service.js';
import { SettingsService } from '../src/services/settings-service.js';
import { ADMIN, OrderService, RequisitesNotSentError, StaleOrderError } from '../src/services/order-service.js';
import { balanceOf } from '../src/services/ledger-service.js';
import { RATE_SCALE } from '../src/domain/pricing.js';

// Запуск: TEST_DATABASE_URL=postgresql://... pnpm test  (БД с применёнными миграциями; данные очищаются!)
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('db integration', () => {
  let db: Db;
  beforeAll(async () => {
    db = createDb(url!);
    await db.$executeRawUnsafe(
      'TRUNCATE "Invite","Setting","TrustedDomain","PaymentMethod","LedgerEntry","OrderEvent","User" RESTART IDENTITY CASCADE',
    );
  });
  afterAll(async () => db.$disconnect());

  it('bootstraps defaults once', async () => {
    await bootstrapDefaults(db);
    await bootstrapDefaults(db);
    expect(await db.trustedDomain.count()).toBe(5);
    expect(await db.paymentMethod.count()).toBe(3);
  });

  it('redeems an invite exactly once, even concurrently', async () => {
    const admin = await db.user.create({ data: { telegramId: 1n, displayName: 'Admin', role: 'ADMIN' } });
    const invites = new InviteService(db);
    const inv = await invites.create(admin.id, 72);

    const results = await Promise.all(
      [10n, 11n, 12n].map((id) => invites.redeem(inv.code, { id, displayName: `U${id}` })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.user.count({ where: { role: 'CLIENT' } })).toBe(1); // проигравшие откатились

    const again = await invites.redeem(inv.code, { id: 99n, displayName: 'Late' });
    expect(again.ok).toBe(false);
  });

  it('rejects expired and malformed invites', async () => {
    const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    const invites = new InviteService(db);
    const expired = await invites.create(admin.id, 1);
    await db.invite.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await invites.redeem(expired.code, { id: 50n, displayName: 'X' })).ok).toBe(false);
    expect((await invites.redeem('bad code', { id: 51n, displayName: 'X' })).ok).toBe(false);
  });

  it('persists settings over defaults', async () => {
    const s = new SettingsService(db);
    expect((await s.getAll()).markupBp).toBe(500);
    await s.set('markupBp', 250);
    expect((await s.getAll()).markupBp).toBe(250);
  });

  it('ledger is append-only', async () => {
    const client = await db.user.findFirstOrThrow({ where: { role: 'CLIENT' } });
    const e = await db.ledgerEntry.create({ data: { clientId: client.id, type: 'TOPUP', amountMinor: 1000n } });
    await expect(db.ledgerEntry.update({ where: { id: e.id }, data: { amountMinor: 1n } })).rejects.toThrow(/append-only/);
    await expect(db.ledgerEntry.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
  });

  it('concurrent admin clicks on the same order version: exactly one wins, ledger written once', async () => {
    const rates = { getRate: async (currency: string) => ({ currency, scaled: 90n * RATE_SCALE, source: 'MANUAL' as const, at: new Date() }) };
    const settings = new SettingsService(db);
    const orders = new OrderService(db, rates, settings, Buffer.alloc(32, 1));
    const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    const client = await db.user.findFirstOrThrow({ where: { role: 'CLIENT' } });
    const before = await balanceOf(db, client.id);

    const o = await orders.create({
      clientId: client.id, type: 'OTHER', service: 'Svc', amountMinor: 1000n, currency: 'USD', isSubscription: false,
    });
    const quoted = await orders.quote(o.id, o.version, ADMIN(admin.id));
    // PREPAY: клиент подтвердил и «оплатил» — доводим до PAYMENT_CHECK напрямую
    const confirmed = await orders.confirmQuote(o.id, quoted.version, client.id, null);
    // оплату можно отметить только после того, как админ прислал реквизиты (выбрал способ)
    await expect(orders.markPaid(o.id, confirmed.order.version, client.id)).rejects.toBeInstanceOf(RequisitesNotSentError);
    await orders.setPayMethod(o.id, confirmed.order.version, admin.id, 1, 'СБП');
    const paid = await orders.markPaid(o.id, confirmed.order.version, client.id);

    const results = await Promise.allSettled([
      orders.confirmPayment(o.id, paid.version, admin.id),
      orders.confirmPayment(o.id, paid.version, admin.id),
      orders.confirmPayment(o.id, paid.version, admin.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(StaleOrderError);
    expect(await balanceOf(db, client.id)).toBe(before + quoted.totalMinor!);
  });
});
