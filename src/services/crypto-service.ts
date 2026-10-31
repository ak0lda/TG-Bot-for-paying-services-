import type { Db } from '../db/client.js';
import { creditKopecks, pickInvoiceAmount } from '../domain/crypto-invoice.js';
import type { Config } from '../config.js';
import type { RatesService } from './rates.js';
import type { SettingsService } from './settings-service.js';
import type { TopUpWithClient } from './topup-service.js';
import type { TronGridClient, TronTransfer } from './tron.js';

const GRACE_MS = 10 * 60_000; // перевод может подтвердиться в сети уже после истечения счёта
const DUST_MICRO = 1_000_000n; // меньше 1 USDT — «пыль» (в т.ч. address poisoning), игнорируем молча
const LOCK_KEY = 7701;
const CURSOR_KEY = 'tronCursor';

export class CryptoDisabledError extends Error {}

export interface PollResult {
  matched: TopUpWithClient[];
  unmatched: Array<{ transfer: TronTransfer; expiredTopUpId: number | null }>;
}

export class CryptoService {
  constructor(
    private readonly db: Db,
    private readonly config: Pick<Config, 'CRYPTO_USDT_TRON_ADDRESS' | 'CRYPTO_USDT_CONTRACT'>,
    private readonly rates: RatesService,
    private readonly settings: SettingsService,
    private readonly tron: TronGridClient,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  get enabled(): boolean {
    return !!this.config.CRYPTO_USDT_TRON_ADDRESS;
  }

  get address(): string {
    if (!this.config.CRYPTO_USDT_TRON_ADDRESS) throw new CryptoDisabledError();
    return this.config.CRYPTO_USDT_TRON_ADDRESS;
  }

  /** Счёт на уникальную сумму; курс и комиссия фиксируются сейчас, зачисление — по ним. */
  async createInvoice(clientId: number, requestedMicro: bigint): Promise<TopUpWithClient> {
    const address = this.address;
    void address;
    const s = await this.settings.getAll();
    const rate = await this.rates.getRate('USDT');
    const now = this.now();
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
      const open = await tx.topUp.findMany({
        where: { kind: 'USDT_TRC20', status: 'PENDING', expiresAt: { gt: new Date(now.getTime() - GRACE_MS) } },
        select: { cryptoAmountMicro: true },
      });
      const taken = new Set(open.map((o) => o.cryptoAmountMicro!));
      const amountMicro = pickInvoiceAmount(requestedMicro, taken, this.random);
      return tx.topUp.create({
        data: {
          clientId,
          kind: 'USDT_TRC20',
          amountMinor: creditKopecks(amountMicro, rate.scaled, s.cryptoFeeBp),
          cryptoAmountMicro: amountMicro,
          cryptoRateScaled: rate.scaled,
          expiresAt: new Date(now.getTime() + s.cryptoInvoiceTtlMin * 60_000),
        },
        include: { client: true, method: true },
      });
    });
  }

  /** Клиент отменяет неоплаченный счёт. */
  async cancelInvoice(id: number, clientId: number): Promise<boolean> {
    const res = await this.db.topUp.updateMany({
      where: { id, clientId, kind: 'USDT_TRC20', status: 'PENDING', cryptoTxId: null },
      data: { status: 'REJECTED' },
    });
    return res.count === 1;
  }

  /** Просроченные неоплаченные счета -> REJECTED. Возвращает их для уведомления клиентов. */
  async expireInvoices(): Promise<TopUpWithClient[]> {
    const due = await this.db.topUp.findMany({
      where: {
        kind: 'USDT_TRC20',
        status: 'PENDING',
        cryptoTxId: null,
        expiresAt: { lt: new Date(this.now().getTime() - GRACE_MS) },
      },
      select: { id: true },
    });
    const out: TopUpWithClient[] = [];
    for (const { id } of due) {
      const res = await this.db.topUp.updateMany({
        where: { id, status: 'PENDING', cryptoTxId: null },
        data: { status: 'REJECTED' },
      });
      if (res.count === 1)
        out.push((await this.db.topUp.findUnique({ where: { id }, include: { client: true, method: true } }))!);
    }
    return out;
  }

  /** Опрос блокчейна: новые входящие переводы -> привязка к счетам. Подтверждает зачисление всегда админ. */
  async poll(): Promise<PollResult> {
    const address = this.address;
    const cursorRow = await this.db.setting.findUnique({ where: { key: CURSOR_KEY } });
    const now = this.now().getTime();
    const cursor = typeof cursorRow?.value === 'number' ? cursorRow.value : now - 3_600_000;
    const oldest = await this.db.topUp.findFirst({
      where: { kind: 'USDT_TRC20', status: 'PENDING', cryptoTxId: null },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const since = Math.min(cursor - 60_000, oldest ? oldest.createdAt.getTime() : Infinity);
    const transfers = await this.tron.incomingUsdt(address, this.config.CRYPTO_USDT_CONTRACT, since);

    const result: PollResult = { matched: [], unmatched: [] };
    let maxTs = cursor;
    for (const t of transfers) {
      maxTs = Math.max(maxTs, t.at.getTime());
      if (await this.db.cryptoTransfer.findUnique({ where: { txid: t.txid } })) continue;
      if (t.amountMicro < DUST_MICRO) {
        await this.record(t, null, true);
        continue;
      }
      const topUpId = await this.match(t);
      if (topUpId !== null) {
        result.matched.push(
          (await this.db.topUp.findUnique({ where: { id: topUpId }, include: { client: true, method: true } }))!,
        );
      } else {
        const expired = await this.db.topUp.findFirst({
          where: { kind: 'USDT_TRC20', status: 'REJECTED', cryptoTxId: null, cryptoAmountMicro: t.amountMicro },
          orderBy: { id: 'desc' },
          select: { id: true },
        });
        await this.record(t, null, true);
        result.unmatched.push({ transfer: t, expiredTopUpId: expired?.id ?? null });
      }
    }
    if (maxTs > cursor || !cursorRow) {
      await this.db.setting.upsert({
        where: { key: CURSOR_KEY },
        create: { key: CURSOR_KEY, value: maxTs },
        update: { value: maxTs },
      });
    }
    return result;
  }

  private record(t: TronTransfer, topUpId: number | null, notified: boolean) {
    return this.db.cryptoTransfer
      .create({
        data: {
          txid: t.txid,
          amountMicro: t.amountMicro,
          fromAddress: t.from,
          blockTimestamp: t.at,
          topUpId,
          notified,
        },
      })
      .catch(() => undefined); // гонка двух опросов: txid уже записан
  }

  private async match(t: TronTransfer): Promise<number | null> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
      const topUp = await tx.topUp.findFirst({
        where: {
          kind: 'USDT_TRC20',
          status: 'PENDING',
          cryptoTxId: null,
          cryptoAmountMicro: t.amountMicro,
          createdAt: { lte: t.at },
          expiresAt: { gte: new Date(t.at.getTime() - GRACE_MS) },
        },
        orderBy: { id: 'asc' },
      });
      if (!topUp) return null;
      await tx.topUp.update({ where: { id: topUp.id }, data: { cryptoTxId: t.txid } });
      await tx.cryptoTransfer.create({
        data: {
          txid: t.txid,
          amountMicro: t.amountMicro,
          fromAddress: t.from,
          blockTimestamp: t.at,
          topUpId: topUp.id,
          notified: true,
        },
      });
      return topUp.id;
    });
  }
}
