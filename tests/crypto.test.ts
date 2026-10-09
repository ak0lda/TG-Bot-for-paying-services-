import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/services/crypto.js';

const key = randomBytes(32);

describe('AES-256-GCM', () => {
  it('round-trips unicode', () => {
    const secret = 'ABCD-1234-ЭФГХ 🎁';
    expect(decrypt(encrypt(secret, key), key)).toBe(secret);
  });

  it('uses a fresh IV each time and does not leak plaintext', () => {
    const a = encrypt('same', key);
    const b = encrypt('same', key);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('same'))).toBe(false);
  });

  it('rejects tampered ciphertext', () => {
    const enc = encrypt('secret', key);
    enc[enc.length - 1] = (enc[enc.length - 1] ?? 0) ^ 1;
    expect(() => decrypt(enc, key)).toThrow();
  });

  it('rejects wrong key and short payload and bad key length', () => {
    expect(() => decrypt(encrypt('x', key), randomBytes(32))).toThrow();
    expect(() => decrypt(Buffer.alloc(5), key)).toThrow();
    expect(() => encrypt('x', randomBytes(16))).toThrow();
  });
});
