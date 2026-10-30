import { GrammyError, HttpError } from 'grammy';

/**
 * Безопасное описание ошибки для логов и алертов.
 * Сообщения исключений нельзя писать в лог «как есть»: у ошибок Prisma в тексте бывают значения запроса
 * (названия сервисов, комментарии клиентов), у сетевых ошибок — URL с токеном бота. Поэтому:
 *  - Prisma: только имя и код (P2002…);
 *  - Telegram: код ответа, метод и усечённое описание;
 *  - прочие: имя и первая строка сообщения, с замаскированными токенами и длинными числами.
 */
export interface SafeError {
  err: string;
  code?: string;
}

const TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;
const LONG_DIGITS_RE = /\d{9,}/g;
const MAX = 160;

export const mask = (s: string): string => s.replace(TOKEN_RE, '[token]').replace(LONG_DIGITS_RE, '[num]');
const firstLine = (s: string): string => mask(s.split('\n')[0] ?? '').slice(0, MAX);

export function safeError(e: unknown): SafeError {
  if (e instanceof GrammyError) {
    return { err: `GrammyError ${e.error_code} ${e.method}: ${firstLine(e.description).slice(0, 80)}`, code: String(e.error_code) };
  }
  if (e instanceof HttpError) {
    const cause = (e.error as { code?: unknown } | undefined)?.code;
    return { err: `HttpError (network)${typeof cause === 'string' ? ` ${cause}` : ''}`, ...(typeof cause === 'string' ? { code: cause } : {}) };
  }
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const codeStr = typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
    if (e.name.startsWith('PrismaClient') || e.constructor.name.startsWith('PrismaClient')) {
      return { err: `${e.name}${codeStr ? ` ${codeStr}` : ''}`, ...(codeStr ? { code: codeStr } : {}) };
    }
    if (e.name === 'ZodError') return { err: 'ZodError (validation)' };
    const name = e.name && e.name !== 'Error' ? e.name : e.constructor.name;
    return { err: `${name}: ${firstLine(e.message)}`.slice(0, MAX), ...(codeStr ? { code: codeStr } : {}) };
  }
  return { err: `non-error thrown: ${typeof e}` };
}
