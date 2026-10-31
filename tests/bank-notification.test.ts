import { describe, expect, it } from 'vitest';
import { parseAmountToken, parseBankNotification } from '../src/domain/bank-notification.js';

const one = (text: string) => parseBankNotification(text).map((p) => [p.amountMinor, p.currency, p.incoming]);

describe('parseAmountToken', () => {
  it.each([
    ['5800', 580_000n],
    ['5 800', 580_000n],
    ['5 800,50', 580_050n],
    ['5,800.00', 580_000n],
    ['5.800,00', 580_000n],
    ['1,234,567.89', 123_456_789n],
    ['1.234.567,89', 123_456_789n],
    ['964,00', 96_400n],
    ['964.5', 96_450n],
    ['5,800', 580_000n], // три цифры после единственного разделителя — тысячи
    ['5.800', 580_000n],
    ['0,50', 50n],
  ])('%s', (tok, expected) => expect(parseAmountToken(tok)).toBe(expected));

  it.each(['', 'abc', '5..8', '1,23,456', '12,345.678', '1.2.3'])('rejects %j', (tok) =>
    expect(parseAmountToken(tok)).toBeNull(),
  );
});

describe('parseBankNotification', () => {
  it('incoming transfer in different phrasings', () => {
    expect(one('Поступление 5 800,00 RUB. Баланс: 12 345,00 RUB')).toEqual([[580_000n, 'RUB', true]]);
    expect(one('Зачислен перевод от ИВАН И. 964 ₽')).toEqual([[96_400n, 'RUB', true]]);
    expect(one('+5800 ₽ Перевод от Иван Иванович')).toEqual([[580_000n, 'RUB', true]]);
    expect(one('Credit: RUB 5,800.00. Available: RUB 12,345.00')).toEqual([[580_000n, 'RUB', true]]);
    expect(one('You received 1 964,50 руб. от клиента')).toEqual([[196_450n, 'RUB', true]]);
    expect(one('Пополнение счёта на 5800р')).toEqual([[580_000n, 'RUB', true]]);
    expect(one('Вам пришёл перевод 7 500 рублей')).toEqual([[750_000n, 'RUB', true]]);
  });

  it('outgoing operations are recognised as such', () => {
    expect(one('Списание 500,00 RUB. Остаток 100,00 RUB')).toEqual([[50_000n, 'RUB', false]]);
    expect(one('Покупка 1 299,00 ₽ NETFLIX')).toEqual([[129_900n, 'RUB', false]]);
    expect(one('-964 ₽ оплата услуг')).toEqual([[96_400n, 'RUB', false]]);
    expect(one('Перевод на карту 3 000 руб.')).toEqual([[300_000n, 'RUB', false]]);
  });

  it('an explicit sign beats keywords; contradictory keywords => unknown', () => {
    expect(one('Операция: +5 000 ₽ (оплата заказа)')).toEqual([[500_000n, 'RUB', true]]);
    expect(one('5 000 ₽')).toEqual([[500_000n, 'RUB', null]]);
    expect(one('Поступление и списание 5 000 ₽')).toEqual([[500_000n, 'RUB', null]]);
  });

  it('ignores balances, fees, limits and cashback; keeps the operation amount', () => {
    expect(one('Поступление 5 800 ₽, комиссия 0 ₽, баланс 100 000 ₽')).toEqual([[580_000n, 'RUB', true]]);
    expect(one('Остаток: 1 000 ₽')).toEqual([]);
    expect(one('Кешбэк 50 ₽, доступно 200 ₽')).toEqual([]);
  });

  it('other currencies are reported with their code (the bot only matches roubles)', () => {
    expect(one('Credited $100.00')).toEqual([[10_000n, 'USD', true]]);
    expect(one('Поступление 250,00 GEL')).toEqual([[25_000n, 'GEL', true]]);
    expect(one('Received €50')).toEqual([[5_000n, 'EUR', true]]);
    expect(one('Поступление 1 000 ₾')).toEqual([[100_000n, 'GEL', true]]);
  });

  it('several different amounts are all returned, duplicates collapsed', () => {
    expect(one('Поступление 964 ₽ ... итого 964,00 ₽ ... и 5 800 ₽')).toEqual([
      [96_400n, 'RUB', true],
      [580_000n, 'RUB', true],
    ]);
  });

  it('non-payment texts yield nothing', () => {
    for (const t of [
      'привет',
      'Код подтверждения 482913',
      'Заказ №12345 готов',
      '2026-10-31 12:00',
      'тариф на 12 месяцев',
      '+7 900 111-22-33',
    ]) {
      expect(one(t), t).toEqual([]);
    }
  });

  it('does not take digits glued to words or phone-like groups as money', () => {
    expect(one('Звоните 8 800 555 35 35 руб')).not.toContainEqual([880_055_535_35n, 'RUB', null]);
    expect(one('карта *4417 поступление 1 000 ₽')).toEqual([[100_000n, 'RUB', true]]);
  });
});
