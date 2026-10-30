import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM с версионированием ключей (ротация без простоя).
 *
 * Формат нового шифртекста: 'E' '1' | keyId(1 байт) | iv(12) | tag(16) | ciphertext.
 * Заголовок (магия + keyId) входит в AAD, поэтому подмена идентификатора ключа ломает проверку подлинности.
 * Старый формат (без заголовка): iv(12) | tag(16) | ciphertext — читается ключом с id = LEGACY_KEY_ID.
 */
const MAGIC = Buffer.from('E1');
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1;
export const LEGACY_KEY_ID = 1;

export interface Keyring {
  /** Ключ, которым шифруются новые данные. */
  currentId: number;
  /** Все известные ключи (текущий и старые — для чтения до перешифровки). */
  keys: ReadonlyMap<number, Buffer>;
}

export class UnknownKeyError extends Error {
  constructor(readonly keyId: number) {
    super(`encryption key ${keyId} is not available`);
  }
}

export function makeKeyring(currentId: number, current: Buffer, old: ReadonlyMap<number, Buffer> = new Map()): Keyring {
  const check = (id: number, key: Buffer) => {
    if (!Number.isInteger(id) || id < 1 || id > 255) throw new Error('key id must be an integer 1..255');
    if (key.length !== 32) throw new Error('key must be 32 bytes');
  };
  check(currentId, current);
  const keys = new Map<number, Buffer>();
  for (const [id, key] of old) {
    check(id, key);
    if (id === currentId) throw new Error(`key id ${id} is used for both current and old keys`);
    keys.set(id, key);
  }
  keys.set(currentId, current);
  return { currentId, keys };
}

export function encrypt(plaintext: string, ring: Keyring): Buffer {
  const key = ring.keys.get(ring.currentId);
  if (!key) throw new UnknownKeyError(ring.currentId);
  const header = Buffer.concat([MAGIC, Buffer.from([ring.currentId])]);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ct]);
}

function open(payload: Buffer, key: Buffer, aad: Buffer | null, offset: number): string {
  if (payload.length < offset + IV_LEN + TAG_LEN) throw new Error('payload too short');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(offset, offset + IV_LEN));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(payload.subarray(offset + IV_LEN, offset + IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(payload.subarray(offset + IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
}

export function decrypt(payload: Uint8Array, ring: Keyring): string {
  const buf = Buffer.from(payload);
  let newFormatError: unknown;
  if (buf.length >= HEADER_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    const keyId = buf[MAGIC.length]!;
    const key = ring.keys.get(keyId);
    if (key) {
      try {
        return open(buf, key, buf.subarray(0, HEADER_LEN), HEADER_LEN);
      } catch (e) {
        newFormatError = e; // возможно, это старый формат, у которого случайный IV совпал с магией (1/65536)
      }
    } else {
      newFormatError = new UnknownKeyError(keyId);
    }
  }
  const legacy = ring.keys.get(LEGACY_KEY_ID);
  if (legacy) {
    try {
      return open(buf, legacy, null, 0);
    } catch (e) {
      throw newFormatError ?? e;
    }
  }
  throw newFormatError ?? new UnknownKeyError(LEGACY_KEY_ID);
}

/** Нужна ли перешифровка: данные зашифрованы не текущим ключом (или в старом формате). */
export function needsRotation(payload: Uint8Array, ring: Keyring): boolean {
  const buf = Buffer.from(payload);
  const isNew = buf.length >= HEADER_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
  return !isNew || buf[MAGIC.length] !== ring.currentId;
}

/** "2:base64,3:base64" -> Map. */
export function parseOldKeys(raw: string | undefined): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,3}):([A-Za-z0-9+/=_-]+)$/.exec(part);
    if (!m) throw new Error('ENCRYPTION_KEYS_OLD must look like "1:<base64>,2:<base64>"');
    const id = Number(m[1]);
    if (out.has(id)) throw new Error(`duplicate old key id ${id}`);
    out.set(id, Buffer.from(m[2]!, 'base64'));
  }
  return out;
}
