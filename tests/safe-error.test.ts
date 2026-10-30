import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { mask, safeError } from '../src/logging/safe-error.js';

class PrismaClientKnownRequestError extends Error {
  code = 'P2002';
  constructor(msg: string) {
    super(msg);
    this.name = 'PrismaClientKnownRequestError';
  }
}

describe('safeError', () => {
  it('never leaks Prisma query values (client text lives in the message)', () => {
    const e = new PrismaClientKnownRequestError('Invalid `prisma.order.create()` invocation:\n{ data: { service: "Секретный сервис Васи", comment: "мой пароль 123" } }');
    expect(safeError(e)).toEqual({ err: 'PrismaClientKnownRequestError P2002', code: 'P2002' });
  });

  it('keeps Telegram API error code, method and a short description', () => {
    const e = new GrammyError('x', { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 'sendMessage', {});
    expect(safeError(e)).toEqual({ err: 'GrammyError 403 sendMessage: Forbidden: bot was blocked by the user', code: '403' });
  });

  it('network errors expose only the system code, never the URL (it contains the bot token)', () => {
    const cause = Object.assign(new Error('fetch https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage failed'), { code: 'ECONNRESET' });
    const e = new HttpError("Network request for 'sendMessage' failed!", cause);
    const out = safeError(e);
    expect(out).toEqual({ err: 'HttpError (network) ECONNRESET', code: 'ECONNRESET' });
    expect(JSON.stringify(out)).not.toMatch(/AAAA|api\.telegram/);
  });

  it('masks tokens and long numbers in generic messages, keeps one line only', () => {
    const e = new Error('boom 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi and id 99887766554433\nstack-ish second line with secrets');
    const out = safeError(e).err;
    expect(out).toBe('Error: boom [token] and id [num]');
    expect(out).not.toContain('second line');
  });

  it('truncates, names custom errors, handles zod and non-errors', () => {
    class StaleOrderError extends Error {}
    expect(safeError(new StaleOrderError('stale order version')).err).toBe('StaleOrderError: stale order version');
    expect(safeError(new Error('x'.repeat(500))).err.length).toBeLessThanOrEqual(160);
    const z = Object.assign(new Error('[{"path":["service"],"message":"secret value"}]'), { name: 'ZodError' });
    expect(safeError(z).err).toBe('ZodError (validation)');
    expect(safeError('plain string with secret')).toEqual({ err: 'non-error thrown: string' });
    expect(safeError(null).err).toBe('non-error thrown: object');
  });

  it('mask() is idempotent', () => {
    expect(mask(mask('t 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'))).toBe('t [token]');
  });
});
