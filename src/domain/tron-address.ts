import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s: string): Buffer | null {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  const zeros = s.length - s.replace(/^1+/, '').length; // ведущие «1» — нулевые байты
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/**
 * Адрес Tron: base58check, 25 байт = префикс 0x41 + 20 байт + 4 байта контрольной суммы (sha256 дважды).
 * Проверяем и формат, и контрольную сумму: опечатка в адресе получателя = потерянные деньги клиентов.
 */
export function isValidTronAddress(address: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const raw = base58Decode(address);
  if (!raw || raw.length !== 25 || raw[0] !== 0x41) return false;
  const checksum = sha256(sha256(raw.subarray(0, 21))).subarray(0, 4);
  return checksum.equals(raw.subarray(21));
}
