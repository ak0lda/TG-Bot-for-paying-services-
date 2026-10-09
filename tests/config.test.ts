import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUV',
  ADMIN_TELEGRAM_ID: '42',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

describe('loadConfig', () => {
  it('applies defaults and parses types', () => {
    const cfg = loadConfig({ ...base, ADMIN_CHAT_ID: '' });
    expect(cfg.ADMIN_TELEGRAM_ID).toBe(42n);
    expect(cfg.ADMIN_CHAT_ID).toBeUndefined();
    expect(cfg.BOT_MODE).toBe('polling');
    expect(cfg.ENCRYPTION_KEY.length).toBe(32);
  });

  it('rejects a bad encryption key', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('requires webhook settings in webhook mode', () => {
    expect(() => loadConfig({ ...base, BOT_MODE: 'webhook' })).toThrow(/WEBHOOK_URL/);
    const cfg = loadConfig({
      ...base,
      BOT_MODE: 'webhook',
      WEBHOOK_URL: 'https://bot.example.com/webhook',
      WEBHOOK_SECRET: 'abcdefghijklmnop1234',
    });
    expect(cfg.BOT_MODE).toBe('webhook');
  });
});
