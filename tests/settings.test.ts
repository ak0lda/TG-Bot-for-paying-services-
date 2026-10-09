import { describe, expect, it } from 'vitest';
import {
  SettingParseError,
  defaultSettings,
  formatSettingValue,
  isSettingKey,
  parseSettingInput,
} from '../src/domain/settings.js';

describe('settings', () => {
  it('parses percents to basis points', () => {
    expect(parseSettingInput('markupBp', '5')).toBe(500);
    expect(parseSettingInput('markupBp', '2,5%')).toBe(250);
    expect(parseSettingInput('fxBufferBp', '0')).toBe(0);
  });

  it('parses rubles to kopecks', () => {
    expect(parseSettingInput('fixedFeeMinor', '99,90')).toBe(9990);
    expect(parseSettingInput('fixedFeeMinor', '50 ₽')).toBe(5000);
  });

  it('parses ints within range', () => {
    expect(parseSettingInput('quoteTtlHours', '24')).toBe(24);
    expect(() => parseSettingInput('quoteTtlHours', '0')).toThrow(SettingParseError);
    expect(() => parseSettingInput('reminderHour', '24')).toThrow(SettingParseError);
    expect(() => parseSettingInput('quoteTtlHours', '1.5')).toThrow(SettingParseError);
    expect(() => parseSettingInput('markupBp', 'abc')).toThrow(SettingParseError);
    expect(() => parseSettingInput('markupBp', '-1')).toThrow(SettingParseError);
  });

  it('formats values back', () => {
    expect(formatSettingValue('markupBp', 250)).toBe('2,50');
    expect(formatSettingValue('markupBp', 500)).toBe('5');
    expect(formatSettingValue('quoteTtlHours', 12)).toBe('12');
  });

  it('knows keys and has defaults for all of them', () => {
    expect(isSettingKey('markupBp')).toBe(true);
    expect(isSettingKey('constructor')).toBe(false);
    expect(Object.values(defaultSettings()).every((v) => Number.isInteger(v))).toBe(true);
  });
});
