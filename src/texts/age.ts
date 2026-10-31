/** «5 мин», «3 ч», «2 д» — компактный возраст для списков. */
export function formatAgeShort(from: Date, now: Date = new Date()): string {
  const min = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} ч` : `${Math.floor(h / 24)} д`;
}
