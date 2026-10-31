/**
 * Разбор текста уведомления банка (SMS / push), который админ пересылает боту.
 * Достаёт суммы с валютой и определяет направление (поступление / списание). Текст нигде не сохраняется.
 * Это эвристика под разные форматы («Поступление 5 800,00 RUB», «+5800 ₽», «Credit: RUB 5,800.00»):
 * бот всегда показывает найденное и ждёт подтверждения админа, поэтому ошибка разбора не превращается в деньги.
 */
export interface ParsedAmount {
  amountMinor: bigint;
  /** ISO-код: RUB, USD, EUR, GBP, GEL… */
  currency: string;
  /** true — поступление, false — списание, null — направление не распознано. */
  incoming: boolean | null;
}

const CURRENCY_ALIASES: Array<[RegExp, string]> = [
  [/^(?:₽|руб(?:лей|ля|\.)?|р\.?|rub|rur)$/i, 'RUB'],
  [/^(?:\$|usd|долл(?:аров|\.)?)$/i, 'USD'],
  [/^(?:€|eur|евро)$/i, 'EUR'],
  [/^(?:£|gbp)$/i, 'GBP'],
  [/^(?:₾|gel|лари)$/i, 'GEL'],
  [/^(?:₸|kzt|тенге)$/i, 'KZT'],
  [/^(?:try|₺)$/i, 'TRY'],
];

const CUR = String.raw`(?:₽|руб(?:лей|ля|\.)?|р\.?(?![а-яёa-z])|rub|rur|\$|usd|€|eur|£|gbp|₾|gel|₸|kzt|₺|try)`;
const NUM = String.raw`\d[\d   .,]*\d|\d`;
const SIGN = String.raw`[+\-−–]`;
const NUM_THEN_CUR = new RegExp(String.raw`(?<![\w.,])(${SIGN})?\s?(${NUM})\s?(${CUR})(?![а-яёa-z])`, 'giu');
const CUR_THEN_NUM = new RegExp(String.raw`(?<![а-яёa-z])(${CUR})\s?(${SIGN})?\s?(${NUM})(?![\d])`, 'giu');

const INCOMING = [
  'поступлен',
  'зачислен',
  'пополнен',
  'получен',
  'входящ',
  'перевод от',
  'credited',
  'credit',
  'received',
  'incoming',
  'deposit',
  'пришл',
  'пришёл',
  'пришел',
];
const OUTGOING = [
  'списан',
  'оплата',
  'покупк',
  'снят',
  'выдача',
  'withdraw',
  'debit',
  'purchase',
  'payment to',
  'исходящ',
  'перевод на',
  'отправлен',
];
// Суммы рядом с этими словами — не сумма операции.
const NOT_AN_OPERATION = [
  'баланс',
  'остаток',
  'доступно',
  'balance',
  'available',
  'комисс',
  'fee',
  'лимит',
  'limit',
  'кешбэк',
  'кэшбэк',
  'cashback',
];

/** «5 800,00» | «5,800.00» | «5.800,00» | «5800» | «5 800.5» -> копейки; null — не число. */
export function parseAmountToken(token: string): bigint | null {
  const t = token.replace(/[   ]/g, '');
  if (!/^[\d.,]+$/.test(t) || /[.,]{2,}/.test(t)) return null;
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  let whole: string;
  let frac = '';
  if (lastDot >= 0 && lastComma >= 0) {
    // оба разделителя: десятичный — тот, что правее
    const dec = Math.max(lastDot, lastComma);
    whole = t.slice(0, dec).replace(/[.,]/g, '');
    frac = t.slice(dec + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = t.split(sep);
    const tail = parts[parts.length - 1]!;
    if (parts.length > 2 || tail.length === 3) {
      // «5,800» / «1.234.567» — разделитель тысяч
      if (parts.slice(1).some((p) => p.length !== 3)) return null;
      whole = parts.join('');
    } else {
      whole = parts[0]!;
      frac = tail;
    }
  } else whole = t;
  if (!/^\d+$/.test(whole) || frac.length > 2 || (frac && !/^\d+$/.test(frac))) return null;
  return BigInt(whole + frac.padEnd(2, '0'));
}

function currencyCode(token: string): string | null {
  const t = token.trim();
  for (const [re, code] of CURRENCY_ALIASES) if (re.test(t)) return code;
  return null;
}

export function parseBankNotification(raw: string): ParsedAmount[] {
  const text = raw.replace(/[  ]/g, ' ');
  const lower = text.toLowerCase();
  const hasIn = INCOMING.some((k) => lower.includes(k));
  const hasOut = OUTGOING.some((k) => lower.includes(k));
  const keywordDirection: boolean | null = hasIn && !hasOut ? true : hasOut && !hasIn ? false : null;

  const found: Array<{ index: number; amount: bigint; currency: string; sign: string | undefined }> = [];
  for (const m of text.matchAll(NUM_THEN_CUR)) {
    const amount = parseAmountToken(m[2]!);
    const currency = currencyCode(m[3]!);
    if (amount !== null && currency) found.push({ index: m.index ?? 0, amount, currency, sign: m[1] });
  }
  for (const m of text.matchAll(CUR_THEN_NUM)) {
    const amount = parseAmountToken(m[3]!);
    const currency = currencyCode(m[1]!);
    if (amount !== null && currency) found.push({ index: m.index ?? 0, amount, currency, sign: m[2] });
  }

  const out: ParsedAmount[] = [];
  const seen = new Set<string>();
  for (const f of found.sort((a, b) => a.index - b.index)) {
    if (f.amount <= 0n) continue;
    const before = lower.slice(Math.max(0, f.index - 24), f.index);
    if (NOT_AN_OPERATION.some((k) => before.includes(k))) continue; // «Баланс: 12 345 ₽», «Комиссия 0 ₽»
    const key = `${f.currency}:${f.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const incoming = f.sign === '+' ? true : f.sign ? false : keywordDirection;
    out.push({ amountMinor: f.amount, currency: f.currency, incoming });
  }
  return out;
}
