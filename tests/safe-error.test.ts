import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { codeLocation, mask, safeError } from '../src/logging/safe-error.js';

class PrismaClientKnownRequestError extends Error {
  code = 'P2002';
  constructor(msg: string) {
    super(msg);
    this.name = 'PrismaClientKnownRequestError';
  }
}

describe('safeError', () => {
  it('never leaks Prisma query values (client text lives in the message)', () => {
    const e = new PrismaClientKnownRequestError(
      'Invalid `prisma.order.create()` invocation:\n{ data: { service: "Секретный сервис Васи", comment: "мой пароль 123" } }',
    );
    expect(safeError(e)).toEqual({ err: 'PrismaClientKnownRequestError P2002', code: 'P2002' });
  });

  it('keeps Telegram API error code, method and a short description', () => {
    const e = new GrammyError(
      'x',
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      'sendMessage',
      {},
    );
    expect(safeError(e)).toEqual({
      err: 'GrammyError 403 sendMessage: Forbidden: bot was blocked by the user',
      code: '403',
    });
  });

  it('network errors expose only the system code, never the URL (it contains the bot token)', () => {
    const cause = Object.assign(
      new Error('fetch https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage failed'),
      { code: 'ECONNRESET' },
    );
    const e = new HttpError("Network request for 'sendMessage' failed!", cause);
    const out = safeError(e);
    expect(out).toEqual({ err: 'HttpError (network) ECONNRESET', code: 'ECONNRESET' });
    expect(JSON.stringify(out)).not.toMatch(/AAAA|api\.telegram/);
  });

  it('masks tokens and long numbers in generic messages, keeps one line only', () => {
    const e = new Error(
      'boom 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi and id 99887766554433\nstack-ish second line with secrets',
    );
    const out = safeError(e).err;
    expect(out).toMatch(/^Error: boom \[token\] and id \[num\]( @src\/|$)/);
    expect(out).not.toContain('second line');
  });

  it('truncates, names custom errors, handles zod and non-errors', () => {
    class StaleOrderError extends Error {}
    expect(safeError(new StaleOrderError('stale order version')).err).toMatch(/^StaleOrderError: stale order version/);
    expect(safeError(new Error('x'.repeat(500))).err.length).toBeLessThanOrEqual(220);
    const z = Object.assign(new Error('[{"path":["service"],"message":"secret value"}]'), { name: 'ZodError' });
    expect(safeError(z).err).toBe('ZodError (validation)');
    expect(safeError('plain string with secret')).toEqual({ err: 'non-error thrown: string' });
    expect(safeError(null).err).toBe('non-error thrown: object');
  });

  it('SyntaxError text (it quotes the parsed input) is dropped; code location is kept', () => {
    let e: unknown;
    try {
      JSON.parse('{"comment": "секрет клиента ');
    } catch (err) {
      e = err;
    }
    const out = safeError(e).err;
    expect(out).not.toMatch(/секрет|Unexpected|JSON/);
    expect(out).toMatch(/^SyntaxError/);
  });

  it('codeLocation takes the first src/dist frame and hides absolute paths', () => {
    const stack =
      'Error: x\n    at a (/usr/lib/node_modules/foo/index.js:1:1)\n    at b (/app/dist/bot/index.js:42:7)\n    at c (/app/dist/x.js:1:1)';
    expect(codeLocation(stack)).toBe('dist/bot/index.js:42');
    expect(codeLocation('Error: x')).toBeUndefined();
  });

  it('mask() is idempotent', () => {
    expect(mask(mask('t 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'))).toBe('t [token]');
  });
});
