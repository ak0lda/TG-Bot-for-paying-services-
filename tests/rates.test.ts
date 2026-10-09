import { describe, expect, it, vi } from 'vitest';
import { RATE_SCALE } from '../src/domain/pricing.js';
import { RateUnavailableError, RatesService, parseCbrXml } from '../src/services/rates.js';

const XML = `<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="09.10.2026" name="Foreign Currency Market">
<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>92,1234</Value><VunitRate>92,1234</VunitRate></Valute>
<Valute ID="R01820"><NumCode>392</NumCode><CharCode>JPY</CharCode><Nominal>100</Nominal><Name>Иен</Name><Value>60,1234</Value><VunitRate>0,601234</VunitRate></Valute>
<Valute ID="BAD"><CharCode>XXX</CharCode><Nominal>0</Nominal><Value>1,0</Value></Valute>
</ValCurs>`;

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
const fakeDb = (manual: Record<string, string> = {}) =>
  ({
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const v = manual[where.key.replace('manualRate:', '')];
        return v ? { value: v, updatedAt: new Date(0) } : null;
      },
    },
  }) as never;

describe('parseCbrXml', () => {
  it('parses per-unit rates scaled by 1e8 and skips junk', () => {
    const m = parseCbrXml(XML);
    expect(m.get('USD')).toBe(9_212_340_000n);
    expect(m.get('JPY')).toBe(60_123_400n); // 0,601234 ₽ за 1 иену
    expect(m.has('XXX')).toBe(false);
  });
});

describe('RatesService', () => {
  it('caches CBR for an hour, refetches after, and falls back to stale cache on failure', async () => {
    let now = new Date('2026-10-09T10:00:00Z');
    const fetchXml = vi.fn().mockResolvedValue(XML);
    const svc = new RatesService(fakeDb(), log, fetchXml, () => now);

    expect((await svc.getRate('usd')).scaled).toBe(9_212_340_000n);
    await svc.getRate('USD');
    expect(fetchXml).toHaveBeenCalledTimes(1);

    now = new Date('2026-10-09T10:59:00Z');
    await svc.getRate('USD');
    expect(fetchXml).toHaveBeenCalledTimes(1);

    now = new Date('2026-10-09T11:01:00Z');
    fetchXml.mockRejectedValueOnce(new Error('network down'));
    const r = await svc.getRate('USD');
    expect(r).toMatchObject({ source: 'CBR', scaled: 9_212_340_000n });
    expect(fetchXml).toHaveBeenCalledTimes(2);
  });

  it('manual rate wins; RUB is 1; unknown currency or no data throws', async () => {
    const svc = new RatesService(fakeDb({ USD: '9500000000' }), log, async () => XML);
    expect(await svc.getRate('USD')).toMatchObject({ source: 'MANUAL', scaled: 9_500_000_000n });
    expect((await svc.getRate('RUB')).scaled).toBe(RATE_SCALE);
    await expect(svc.getRate('ZZZ')).rejects.toBeInstanceOf(RateUnavailableError);

    const down = new RatesService(fakeDb(), log, async () => {
      throw new Error('down');
    });
    await expect(down.getRate('USD')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});
