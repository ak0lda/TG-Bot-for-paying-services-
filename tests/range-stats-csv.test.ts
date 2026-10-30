import { describe, expect, it } from 'vitest';
import { csvCell, moneyCell, text, toCsv } from '../src/domain/csv.js';
import { parseRange, startOfLocalDay } from '../src/domain/range.js';
import { buildStats, type DoneOrder } from '../src/domain/stats.js';

const TZ = 'Europe/Moscow'; // UTC+3 без перехода на летнее время
const now = new Date('2026-10-09T21:30:00Z'); // 10.10.2026 00:30 по Москве — уже «завтра» относительно UTC

describe('startOfLocalDay', () => {
  it('returns the UTC instant of local midnight', () => {
    expect(startOfLocalDay(2026, 10, 10, TZ).toISOString()).toBe('2026-10-09T21:00:00.000Z');
    expect(startOfLocalDay(2026, 13, 1, TZ).toISOString()).toBe('2026-12-31T21:00:00.000Z'); // нормализация месяца
  });
  it('handles DST zones', () => {
    expect(startOfLocalDay(2026, 7, 1, 'America/New_York').toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(startOfLocalDay(2026, 1, 1, 'America/New_York').toISOString()).toBe('2026-01-01T05:00:00.000Z');
  });
});

describe('parseRange', () => {
  it('uses the local calendar, not UTC', () => {
    const month = parseRange('', now, TZ)!;
    expect(month.from!.toISOString()).toBe('2026-09-30T21:00:00.000Z'); // 01.10 00:00 МСК
    expect(month.to!.toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(month.label).toBe('10.2026');
    const today = parseRange('today', now, TZ)!;
    expect(today.from!.toISOString()).toBe('2026-10-09T21:00:00.000Z');
    expect(today.label).toBe('10.10.2026');
  });
  it('prev month, week, all, explicit ranges', () => {
    expect(parseRange('prev', now, TZ)!.label).toBe('09.2026');
    expect(parseRange('prev', new Date('2026-01-15T12:00:00Z'), TZ)!.label).toBe('12.2025');
    const week = parseRange('week', now, TZ)!; // 10.10.2026 — суббота -> неделя с пн 05.10
    expect(week.label).toBe('05.10.2026 – 10.10.2026');
    expect(parseRange('all', now, TZ)).toEqual({ from: null, to: null, label: 'за всё время' });
    expect(parseRange('2026-02', now, TZ)!.label).toBe('02.2026');
    const r = parseRange('2026-03-01 2026-03-31', now, TZ)!;
    expect(r.to!.toISOString()).toBe('2026-03-31T21:00:00.000Z'); // конец включительно
  });
  it('rejects garbage', () => {
    for (const bad of ['yesterday', '2026-13', '2026-02-30', '2026-03-05 2026-03-01', '12.03.2026']) {
      expect(parseRange(bad, now, TZ)).toBeNull();
    }
  });
});

describe('buildStats', () => {
  const o = (p: Partial<DoneOrder>): DoneOrder => ({
    clientId: 1,
    clientName: 'Вася',
    service: 'Netflix',
    totalMinor: 100_000n,
    costMinor: 90_000n,
    cardLabel: 'Visa ··4417',
    cardCurrency: 'USD',
    chargeInCardCurrencyMinor: 1000n,
    ...p,
  });
  it('aggregates turnover, cost, profit and groups sorted by turnover', () => {
    const s = buildStats([
      o({}),
      o({ service: ' netflix ', totalMinor: 50_000n, costMinor: 49_000n, chargeInCardCurrencyMinor: 500n }),
      o({
        clientId: 2,
        clientName: 'Петя',
        service: 'Steam',
        totalMinor: 300_000n,
        costMinor: 280_000n,
        cardLabel: 'MC ··1111',
        cardCurrency: 'EUR',
        chargeInCardCurrencyMinor: 3000n,
      }),
    ]);
    expect(s).toMatchObject({ count: 3, turnoverMinor: 450_000n, costMinor: 419_000n, profitMinor: 31_000n });
    expect(s.byClient.map((r) => [r.label, r.count, r.turnoverMinor])).toEqual([
      ['#2 Петя', 1, 300_000n],
      ['#1 Вася', 2, 150_000n],
    ]);
    expect(s.byService.map((r) => [r.label, r.count])).toEqual([
      ['Steam', 1],
      ['Netflix', 2],
    ]);
    expect(s.byCard.map((r) => [r.label, r.chargeMinor, r.rubMinor])).toEqual([
      ['MC ··1111', 3000n, 280_000n],
      ['Visa ··4417', 1500n, 139_000n],
    ]);
  });
  it('is empty-safe', () => {
    expect(buildStats([])).toMatchObject({ count: 0, turnoverMinor: 0n, profitMinor: 0n, byClient: [], byCard: [] });
  });
});

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell(text('a,b'))).toBe('"a,b"');
    expect(csvCell(text('say "hi"'))).toBe('"say ""hi"""');
    expect(csvCell(text('line1\nline2'))).toBe('"line1\nline2"');
  });
  it('neutralizes spreadsheet formulas in free text but leaves numbers alone', () => {
    expect(csvCell(text('=HYPERLINK("http://x")'))).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell(text('+1 555'))).toBe("'+1 555");
    expect(csvCell(text('-cmd'))).toBe("'-cmd");
    expect(csvCell(text('@SUM(A1)'))).toBe("'@SUM(A1)");
    expect(csvCell(-5n)).toBe('-5');
    expect(csvCell(moneyCell(-150n))).toBe('-1.50');
  });
  it('formats rows, dates, nulls and money', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          [1, null],
          [new Date('2026-01-02T03:04:05Z'), true],
        ],
      ),
    ).toBe('a,b\r\n1,\r\n2026-01-02T03:04:05.000Z,true\r\n');
    expect(moneyCell(96_400n)).toBe('964.00');
    expect(moneyCell(5n)).toBe('0.05');
    expect(moneyCell(null)).toBeNull();
  });
});
