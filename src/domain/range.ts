export interface DateRange {
  /** Включительно; null — без нижней границы. */
  from: Date | null;
  /** Исключительно; null — без верхней границы. */
  to: Date | null;
  label: string;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function localYmd(date: Date, tz: string): Ymd {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

function tzOffsetMs(date: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return (
    Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) -
    Math.floor(date.getTime() / 1000) * 1000
  );
}

/** Момент полуночи локальной даты в часовом поясе tz (UTC-инстант). Дата нормализуется (месяц 13 -> январь следующего года). */
export function startOfLocalDay(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  const first = new Date(guess - tzOffsetMs(new Date(guess), tz));
  return new Date(guess - tzOffsetMs(first, tz)); // повторная поправка на случай перехода DST
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = ({ y, m, d }: Ymd) => `${pad(d)}.${pad(m)}.${y}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const validYmd = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);

const addDays = ({ y, m, d }: Ymd, n: number): Ymd => {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};

/**
 * Период отчёта в часовом поясе tz:
 * (пусто)|month — текущий месяц; prev — прошлый месяц; today; week — с понедельника; all;
 * YYYY-MM — месяц; YYYY-MM-DD — день; YYYY-MM-DD YYYY-MM-DD — диапазон (обе даты включительно).
 */
export function parseRange(input: string, now: Date, tz: string): DateRange | null {
  const arg = input.trim().toLowerCase();
  const today = localYmd(now, tz);
  const dayRange = (a: Ymd, b: Ymd, label: string): DateRange => ({
    from: startOfLocalDay(a.y, a.m, a.d, tz),
    to: startOfLocalDay(b.y, b.m, b.d + 1, tz),
    label,
  });
  const monthRange = (y: number, m: number): DateRange => ({
    from: startOfLocalDay(y, m, 1, tz),
    to: startOfLocalDay(y, m + 1, 1, tz),
    label: `${pad(m)}.${y}`,
  });

  if (arg === '' || arg === 'month') return monthRange(today.y, today.m);
  if (arg === 'prev') return today.m === 1 ? monthRange(today.y - 1, 12) : monthRange(today.y, today.m - 1);
  if (arg === 'all') return { from: null, to: null, label: 'за всё время' };
  if (arg === 'today') return dayRange(today, today, fmt(today));
  if (arg === 'week') {
    const dow = (new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay() + 6) % 7; // пн = 0
    const start = addDays(today, -dow);
    return dayRange(start, today, `${fmt(start)} – ${fmt(today)}`);
  }

  let m = /^(\d{4})-(\d{2})$/.exec(arg);
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    return mo >= 1 && mo <= 12 ? monthRange(y, mo) : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{4})-(\d{2})-(\d{2}))?$/.exec(arg);
  if (m) {
    const a = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    const b = m[4] ? { y: Number(m[4]), m: Number(m[5]), d: Number(m[6]) } : a;
    if (!validYmd(a.y, a.m, a.d) || !validYmd(b.y, b.m, b.d)) return null;
    if (Date.UTC(b.y, b.m - 1, b.d) < Date.UTC(a.y, a.m - 1, a.d)) return null;
    return dayRange(a, b, a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`);
  }
  return null;
}
