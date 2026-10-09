import pino from 'pino';
import type { Config } from './config.js';

// Логируем только технические события. Тексты сообщений, ссылки, коды и имена не логируются.
export function createLogger(cfg: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>) {
  return pino({
    level: cfg.LOG_LEVEL,
    redact: {
      paths: [
        'token',
        '*.token',
        'req.headers.authorization',
        'req.headers["x-telegram-bot-api-secret-token"]',
        'url',
        'text',
        'code',
      ],
      censor: '[redacted]',
    },
    transport: cfg.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
