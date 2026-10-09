import { describe, expect, it } from 'vitest';
import { detectSecret } from '../src/domain/secret-detector.js';

describe('detectSecret', () => {
  it('detects Luhn-valid card numbers in various formats', () => {
    expect(detectSecret('моя карта 4242 4242 4242 4242')).toBe('card_number');
    expect(detectSecret('4111-1111-1111-1111')).toBe('card_number');
    expect(detectSecret('5555555555554444')).toBe('card_number');
  });

  it('ignores ordinary numbers', () => {
    expect(detectSecret('тариф на 12 месяцев, 1500 руб')).toBeNull();
    expect(detectSecret('заказ 1234567890123')).toBeNull(); // не проходит Luhn
    expect(detectSecret('Visa ··4417')).toBeNull();
  });

  it('detects cvv, credentials, otp', () => {
    expect(detectSecret('cvv 123')).toBe('cvv');
    expect(detectSecret('CVC: 4567')).toBe('cvv');
    expect(detectSecret('логин: ivan пароль: Qwerty123')).toBe('credentials');
    expect(detectSecret('password=hunter2')).toBe('credentials');
    expect(detectSecret('me@mail.com:hunter22')).toBe('credentials');
    expect(detectSecret('код из смс: 482913')).toBe('otp');
  });

  it('does not flag harmless words', () => {
    expect(detectSecret('нужна подписка Netflix Premium')).toBeNull();
    expect(detectSecret('логин не нужен, оплата по ссылке')).toBeNull();
    expect(detectSecret('password manager 1Password')).toBeNull();
  });
});
