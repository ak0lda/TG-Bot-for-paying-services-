import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

/** AES-256-GCM. Формат: iv(12) | tag(16) | ciphertext. */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(payload: Uint8Array, key: Buffer): string {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const buf = Buffer.from(payload);
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('payload too short');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
}
