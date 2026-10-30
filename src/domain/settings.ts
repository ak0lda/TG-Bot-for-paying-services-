import { MoneyParseError, parseDecimalToMinor } from './money.js';

type Def = { kind: 'percent' | 'rub' | 'int'; default: number; min: number; max: number; label: string };

// percent хранится в базисных пунктах (2,5% = 250), rub — в копейках.
export const SETTING_DEFS = {
  fxBufferBp: { kind: 'percent', default: 200, min: 0, max: 100_000, label: 'Запас на конвертацию, %' },
  markupBp: { kind: 'percent', default: 500, min: 0, max: 100_000, label: 'Наценка, %' },
  fixedFeeMinor: { kind: 'rub', default: 0, min: 0, max: 100_000_00, label: 'Фиксированная комиссия, ₽' },
  quoteTtlHours: { kind: 'int', default: 12, min: 1, max: 168, label: 'Срок действия расчёта, ч' },
  staleLinkHours: { kind: 'int', default: 24, min: 1, max: 720, label: 'Ссылка считается старой через, ч' },
  giftCodeRetentionDays: {
    kind: 'int',
    default: 7,
    min: 1,
    max: 365,
    label: 'Хранить коды подарочных карт после DONE, дн.',
  },
  debtReminderDays: { kind: 'int', default: 3, min: 1, max: 60, label: 'Напоминание о долге раз в, дн.' },
  subscriptionRemindDays: { kind: 'int', default: 3, min: 1, max: 30, label: 'Напоминание о подписке за, дн.' },
  inviteTtlHours: { kind: 'int', default: 72, min: 1, max: 720, label: 'Срок жизни инвайта, ч' },
  rateJumpBp: { kind: 'percent', default: 500, min: 50, max: 100_000, label: 'Предупреждать о скачке курса от, %' },
  rateStaleHours: { kind: 'int', default: 6, min: 1, max: 168, label: 'Курс ЦБ считается устаревшим через, ч' },
  reminderHour: { kind: 'int', default: 10, min: 0, max: 23, label: 'Час рассылки напоминаний (по TIMEZONE)' },
  defaultPayLaterLimitMinor: {
    kind: 'rub',
    default: 0,
    min: 0,
    max: 10_000_000_00,
    label: 'Лимит «оплаты позже» по умолчанию, ₽',
  },
} as const satisfies Record<string, Def>;

export type SettingKey = keyof typeof SETTING_DEFS;
export type Settings = Record<SettingKey, number>;

export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFS, key);
}

export function defaultSettings(): Settings {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTING_DEFS[k].default])) as Settings;
}

export class SettingParseError extends Error {}

/** Пользовательский ввод -> хранимое значение. */
export function parseSettingInput(key: SettingKey, input: string): number {
  const def: Def = SETTING_DEFS[key];
  let value: number;
  try {
    if (def.kind === 'int') {
      if (!/^\d+$/.test(input.trim())) throw new SettingParseError('нужно целое число');
      value = Number(input.trim());
    } else {
      // percent: «2,5» -> 250 б.п.; rub: «99,90» -> 9990 коп. Оба — сдвиг на 2 знака.
      value = Number(parseDecimalToMinor(input.replace('%', '').replace('₽', '')));
    }
  } catch (e) {
    if (e instanceof MoneyParseError) throw new SettingParseError('нужно число, не более 2 знаков после запятой');
    throw e;
  }
  if (!Number.isSafeInteger(value) || value < def.min || value > def.max) {
    throw new SettingParseError('значение вне допустимого диапазона');
  }
  return value;
}

export function formatSettingValue(key: SettingKey, value: number): string {
  const def: Def = SETTING_DEFS[key];
  if (def.kind === 'int') return String(value);
  const whole = Math.trunc(value / 100);
  const frac = value % 100;
  return frac === 0 ? String(whole) : `${whole},${String(frac).padStart(2, '0')}`;
}
