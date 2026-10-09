export type SecretKind = 'card_number' | 'cvv' | 'credentials' | 'otp';

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const SEP = String.raw`\s*[:=\-–—]\s*`;
const CVV = new RegExp(String.raw`\b(?:cvv2?|cvc2?|cvn|cid|сvv)\b\s*[:=\-–—]?\s*\d{3,4}\b`, 'i');
const CREDENTIALS = new RegExp(
  String.raw`(?:парол[ьяю]?|password|passwd|pass|pwd|пасс|логин|login|username|юзернейм)` + SEP + String.raw`\S{3,}`,
  'i',
);
const EMAIL_PASSWORD = /[^\s@]+@[^\s@]+\.[^\s@:]+:\S{4,}/;
const OTP = new RegExp(
  String.raw`(?:sms|смс|otp|2fa|verification code|код подтверждения|код из (?:sms|смс))\s*[:=\-–—]?\s*\d{4,8}\b`,
  'i',
);

/** Эвристика: похоже ли на банковскую карту, пароль или одноразовый код. Такой текст не сохраняем. */
export function detectSecret(text: string): SecretKind | null {
  for (const m of text.matchAll(/(?<![\d])(?:\d[ -]?){13,19}(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'card_number';
  }
  if (CVV.test(text)) return 'cvv';
  if (CREDENTIALS.test(text) || EMAIL_PASSWORD.test(text)) return 'credentials';
  if (OTP.test(text)) return 'otp';
  return null;
}
