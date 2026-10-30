import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LEGACY_KEY_ID, UnknownKeyError, decrypt, encrypt, makeKeyring, needsRotation, parseOldKeys } from '../src/services/crypto.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const ring1 = makeKeyring(1, k1);
const ring2 = makeKeyring(2, k2, new Map([[1, k1]]));

/** Шифртекст в прежнем формате (до ввода версий ключа): iv | tag | ct. */
function legacyEncrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

describe('AES-256-GCM keyring', () => {
  it('round-trips unicode and stores the key id in the header', () => {
    const secret = 'ABCD-1234-ЭФГХ 🎁';
    const enc = encrypt(secret, ring1);
    expect(decrypt(enc, ring1)).toBe(secret);
    expect(enc.subarray(0, 3)).toEqual(Buffer.from([0x45, 0x31, 1])); // 'E1' + keyId
    expect(encrypt('x', ring2)[2]).toBe(2);
  });

  it('uses a fresh IV each time and does not leak plaintext', () => {
    const a = encrypt('same', ring1);
    const b = encrypt('same', ring1);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('same'))).toBe(false);
  });

  it('rejects tampered ciphertext, wrong key, short payloads', () => {
    const enc = encrypt('secret', ring1);
    const bad = Buffer.from(enc);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    expect(() => decrypt(bad, ring1)).toThrow();
    expect(() => decrypt(enc, makeKeyring(1, randomBytes(32)))).toThrow();
    expect(() => decrypt(Buffer.alloc(5), ring1)).toThrow();
  });

  it('binds the key id to the data: swapping the id in the header breaks authentication', () => {
    const both = makeKeyring(2, k2, new Map([[1, k1]]));
    const enc = encrypt('secret', ring1); // зашифровано ключом 1
    const forged = Buffer.from(enc);
    forged[2] = 2; // выдаём за ключ 2
    expect(() => decrypt(forged, both)).toThrow();
  });

  it('reads old data after rotation and flags it for re-encryption', () => {
    const old = encrypt('legacy-code', ring1);
    expect(decrypt(old, ring2)).toBe('legacy-code'); // новый ключ текущий, старый ещё в связке
    expect(needsRotation(old, ring2)).toBe(true);
    expect(needsRotation(encrypt('x', ring2), ring2)).toBe(false);
    expect(() => decrypt(old, makeKeyring(2, k2))).toThrow(UnknownKeyError); // старый ключ убрали — прочитать нельзя
  });

  it('still decrypts the pre-versioning format with key id 1', () => {
    const legacy = legacyEncrypt('old-format', k1);
    expect(LEGACY_KEY_ID).toBe(1);
    expect(decrypt(legacy, ring1)).toBe('old-format');
    expect(decrypt(legacy, ring2)).toBe('old-format'); // через старый ключ 1
    expect(needsRotation(legacy, ring1)).toBe(true); // даже с текущим id=1: формат без заголовка надо обновить
  });

  it('handles a legacy payload whose random IV happens to start with the magic bytes', () => {
    let legacy: Buffer;
    do legacy = legacyEncrypt('collision', k1);
    while (!(legacy[0] === 0x45 && legacy[1] === 0x31)); // ~1/65536 попыток
    expect(decrypt(legacy, ring1)).toBe('collision');
  }, 60_000);

  it('validates key ids, sizes and the old-keys format', () => {
    expect(() => makeKeyring(0, k1)).toThrow();
    expect(() => makeKeyring(256, k1)).toThrow();
    expect(() => makeKeyring(1, randomBytes(16))).toThrow();
    expect(() => makeKeyring(1, k1, new Map([[1, k2]]))).toThrow(/both/);
    expect(parseOldKeys(undefined).size).toBe(0);
    expect([...parseOldKeys(`1:${k1.toString('base64')},3:${k2.toString('base64')}`).keys()]).toEqual([1, 3]);
    expect(() => parseOldKeys('garbage')).toThrow();
    expect(() => parseOldKeys(`1:${k1.toString('base64')},1:${k2.toString('base64')}`)).toThrow(/duplicate/);
  });
});
