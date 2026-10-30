/**
 * CSV по RFC 4180 (разделитель «,», перевод строки CRLF).
 * Текстовые ячейки защищены от формул Excel/Sheets: значения, начинающиеся с = + - @ (или tab/CR), получают префикс «'».
 */
export type Cell = string | number | bigint | boolean | Date | null | undefined | { text: string };

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  let s: string;
  if (cell instanceof Date) s = cell.toISOString();
  else if (typeof cell === 'object')
    s = FORMULA_START.test(cell.text) ? `'${cell.text}` : cell.text; // свободный текст
  else s = String(cell); // числа и булевы значения не трогаем: «-5» — это число, а не формула
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Помечает значение как свободный текст (будет защищено от формул). */
export const text = (value: string | null | undefined): Cell => (value == null ? null : { text: value });

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Копейки -> «964.00» (точка — универсально для Sheets и скриптов). */
export function moneyCell(minor: bigint | null | undefined): string | null {
  if (minor == null) return null;
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
