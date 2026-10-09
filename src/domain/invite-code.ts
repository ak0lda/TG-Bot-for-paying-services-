import { randomBytes } from 'node:crypto';

// Допустимые символы deep-link payload в Telegram: A-Z a-z 0-9 _ -
const CODE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function generateInviteCode(): string {
  return randomBytes(12).toString('base64url');
}

export function isValidInviteCodeFormat(code: string): boolean {
  return CODE_RE.test(code);
}
