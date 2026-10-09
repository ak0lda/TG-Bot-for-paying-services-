/** Минимальные единицы (строка) -> «1 234,50». Копейки скрываются, если они нулевые. */
export function formatMinor(minor: string | null | undefined): string {
  if (minor == null) return '—';
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '−' : ''}${whole}${frac === '00' ? '' : `,${frac}`}`;
}

export const rub = (minor: string | null | undefined): string => `${formatMinor(minor)} ₽`;
export const money = (minor: string | null | undefined, cur: string | null): string => `${formatMinor(minor)} ${cur ?? ''}`;

export const signedRub = (minor: string): string => (BigInt(minor) > 0n ? `+${rub(minor)}` : rub(minor));

export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
  }).format(new Date(iso));
}

export function ageOf(iso: string): string {
  const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} ч` : `${Math.floor(h / 24)} д`;
}

export const periodText = (kind: string | null, days: number | null): string =>
  kind === 'MONTH' ? 'месяц' : kind === 'YEAR' ? 'год' : kind === 'CUSTOM' ? `${days} дн.` : '';
