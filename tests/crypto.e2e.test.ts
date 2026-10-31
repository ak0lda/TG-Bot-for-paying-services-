import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, CLIENT, createHarness } from './helpers/harness.js';
import { balanceOf } from '../src/services/ledger-service.js';
import { processCrypto } from '../src/services/scheduler.js';

const url = process.env.TEST_DATABASE_URL;
const ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TX = (n: number) => n.toString(16).padStart(64, 'a');

// «TronGrid» из памяти: тест кладёт сюда переводы.
let chain: Array<{ txid: string; value: string; ts: number; to?: string }> = [];
const tronFetch = (async () =>
  new Response(
    JSON.stringify({
      data: chain.map((t) => ({
        transaction_id: t.txid,
        token_info: { address: ADDR },
        block_timestamp: t.ts,
        from: 'TXsender000000000000000000000000000',
        to: t.to ?? ADDR,
        type: 'Transfer',
        value: t.value,
      })),
      meta: {},
    }),
    { status: 200 },
  )) as unknown as typeof fetch;

describe.skipIf(!url)('USDT TRC-20 top-ups', () => {
  const h = url
    ? createHarness(url, { CRYPTO_USDT_TRON_ADDRESS: ADDR }, undefined, { tronFetch })
    : (undefined as never);
  const { db, deps, say, click, lastTo, allTo, alerts, onboard } = h ?? ({} as typeof h);
  afterAll(async () => db.$disconnect());
  beforeEach(async () => {
    chain = [];
    await h.reset();
    await db.setting.deleteMany({});
  });

  async function invoice(amount = '50') {
    await say(CLIENT, '➕ Пополнить баланс');
    await click(CLIENT, 'w:kind:usdt');
    await say(CLIENT, amount);
    return db.topUp.findFirstOrThrow({ orderBy: { id: 'desc' } });
  }

  it('creates an invoice with unique amount, fixed rate and fee; credit is computed once', async () => {
    await onboard();
    await say(ADMIN, '/rate USDT 92');
    const t = await invoice('50');
    expect(t.kind).toBe('USDT_TRC20');
    const micro = t.cryptoAmountMicro!;
    expect(micro).toBeGreaterThan(50_000_100n - 1n);
    expect(micro).toBeLessThanOrEqual(50_009_999n);
    // 1% комиссия по умолчанию: micro × 92 × 0,99
    expect(t.amountMinor).toBe((micro * 9_200_000_000n * 9900n) / (1_000_000_000_000n * 10_000n));
    const msg = lastTo(CLIENT)!;
    expect(msg.text).toContain(ADDR);
    expect(msg.text).toContain(`${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0').slice(0, 4)}`);
    expect(msg.text).toMatch(/TRC-20/);
    expect(h.cbData(msg)).toEqual([`cc:${t.id}`]);
  });

  it('two open invoices never share an amount', async () => {
    await onboard();
    const a = await invoice('50');
    const b = await invoice('50');
    expect(a.cryptoAmountMicro).not.toBe(b.cryptoAmountMicro);
  });

  it('rejects out-of-range and malformed amounts', async () => {
    await onboard();
    await say(CLIENT, '➕ Пополнить баланс');
    await click(CLIENT, 'w:kind:usdt');
    await say(CLIENT, '1');
    expect(lastTo(CLIENT)!.text).toMatch(/от 5 до 5000/);
    await say(CLIENT, 'abc');
    expect(lastTo(CLIENT)!.text).toMatch(/Не удалось разобрать/);
    expect(await db.topUp.count()).toBe(0);
  });

  it('a matching transfer is proposed to admin; credit only after one tap; txid cannot credit twice', async () => {
    const client = await onboard();
    await say(ADMIN, '/rate USDT 92');
    const t = await invoice('50');
    h.sent.length = 0;

    // админ не может подтвердить, пока перевода нет
    await click(ADMIN, `t:${t.id}:ok`);
    expect(alerts().at(-1)).toMatch(/ещё нет в сети/);
    expect(await balanceOf(db, client.id)).toBe(0n);

    chain = [{ txid: TX(1), value: t.cryptoAmountMicro!.toString(), ts: Date.now() + 1000 }];
    await processCrypto(deps);
    expect(allTo(CLIENT)).toMatch(/замечен в сети/);
    const card = lastTo(ADMIN)!;
    expect(card.text).toContain(TX(1));
    expect(await balanceOf(db, client.id)).toBe(0n); // само по себе ничего не зачисляется

    await processCrypto(deps); // повторный опрос тот же перевод не обрабатывает
    expect(await db.cryptoTransfer.count()).toBe(1);

    await click(ADMIN, `t:${t.id}:ok`);
    expect(await balanceOf(db, client.id)).toBe(t.amountMinor);
    await click(ADMIN, `t:${t.id}:ok`);
    expect(await balanceOf(db, client.id)).toBe(t.amountMinor);
  });

  it('wrong amount, dust and foreign-address transfers are not matched; wrong amount alerts admin once', async () => {
    const client = await onboard();
    const t = await invoice('50');
    h.sent.length = 0;
    chain = [
      { txid: TX(2), value: (t.cryptoAmountMicro! + 1n).toString(), ts: Date.now() + 1000 },
      { txid: TX(3), value: '1', ts: Date.now() + 1000 },
      { txid: TX(4), value: t.cryptoAmountMicro!.toString(), ts: Date.now() + 1000, to: 'TXother' },
    ];
    await processCrypto(deps);
    await processCrypto(deps);
    expect((await db.topUp.findUniqueOrThrow({ where: { id: t.id } })).cryptoTxId).toBeNull();
    const adminMsgs = h.sent.filter((s) => s.chat === ADMIN && /без счёта/.test(s.text));
    expect(adminMsgs).toHaveLength(1);
    expect(await balanceOf(db, client.id)).toBe(0n);
  });

  it('expired invoice is rejected; late payment is flagged with a hint', async () => {
    await onboard();
    const t = await invoice('50');
    await db.topUp.update({ where: { id: t.id }, data: { expiresAt: new Date(Date.now() - 3_600_000) } });
    h.sent.length = 0;
    chain = [{ txid: TX(5), value: t.cryptoAmountMicro!.toString(), ts: Date.now() + 1000 }];
    // после истечения счёт закрывается; перевод попадает в «без счёта» с подсказкой
    await deps.crypto.expireInvoices();
    expect((await db.topUp.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('REJECTED');
    await processCrypto(deps);
    expect(allTo(ADMIN)).toMatch(new RegExp(`просроченным счётом #${t.id}`));
  });

  it('client can cancel an unpaid invoice but not a paid one', async () => {
    await onboard();
    const a = await invoice('50');
    await click(CLIENT, `cc:${a.id}`);
    expect((await db.topUp.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('REJECTED');
    const b = await invoice('60');
    await db.topUp.update({ where: { id: b.id }, data: { cryptoTxId: TX(9) } });
    await click(CLIENT, `cc:${b.id}`);
    expect((await db.topUp.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('PENDING');
  });

  it('without an address the USDT option is not offered', async () => {
    const off = createHarness(url!);
    await off.reset();
    await off.onboard();
    await off.say(CLIENT, '➕ Пополнить баланс');
    expect(off.lastTo(CLIENT)!.text).toMatch(/Сколько рублей/);
    expect(off.cbData(off.lastTo(CLIENT))).not.toContain('w:kind:usdt');
    await off.db.$disconnect();
    await h.reset();
  });
});
