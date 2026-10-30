import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AlertService } from '../src/services/alerts.js';
import { readBackupStatus } from '../src/services/backup-health.js';

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;

describe('AlertService', () => {
  it('throttles repeats of the same key but not different keys; zero cooldown always sends', async () => {
    let t = 0;
    const sent: string[] = [];
    const svc = new AlertService({ toAdmin: async (m) => (sent.push(m), true) }, log, 60_000, () => t);
    expect(await svc.alert('a', 'one')).toBe(true);
    expect(await svc.alert('a', 'again')).toBe(false);
    expect(await svc.alert('b', 'other')).toBe(true);
    t = 59_999;
    expect(await svc.alert('a', 'still too early')).toBe(false);
    t = 60_001;
    expect(await svc.alert('a', 'after cooldown')).toBe(true);
    expect(await svc.alert('a', 'forced', 0)).toBe(true);
    expect(sent).toEqual(['one', 'other', 'after cooldown', 'forced']);
  });

  it('error() describes the error safely (no query values, no tokens) and delivery failures never throw', async () => {
    const sent: string[] = [];
    const svc = new AlertService({ toAdmin: async (m) => (sent.push(m), true) }, log);
    const e = Object.assign(new Error('Invalid `prisma.order.create()`: { service: "СЕКРЕТ" }'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
    });
    await svc.error('k', 'Ошибка', e, 'маршрут: GET /x');
    expect(sent[0]).toContain('PrismaClientKnownRequestError P2002');
    expect(sent[0]).not.toContain('СЕКРЕТ');

    const broken = new AlertService(
      {
        toAdmin: async () => {
          throw new Error('telegram down');
        },
      },
      log,
    );
    await expect(broken.alert('x', 'y')).resolves.toBe(false);
  });
});

describe('readBackupStatus', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const sec = (h: number) => Math.floor((now.getTime() - h * 3_600_000) / 1000);
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'bk-'));
    for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
    return d;
  };

  it('ok / stale / failed / missing', async () => {
    expect(await readBackupStatus(dir({ '.last_success': `${sec(5)} bot-1.sql.gz.age` }), now, 36)).toEqual({
      state: 'ok',
      ageHours: 5,
    });
    expect(await readBackupStatus(dir({ '.last_success': `${sec(40)}` }), now, 36)).toEqual({
      state: 'stale',
      ageHours: 40,
    });
    expect(await readBackupStatus(dir({}), now, 36)).toEqual({ state: 'missing' });
    expect(await readBackupStatus('/definitely/not/here', now, 36)).toEqual({ state: 'missing' });
  });

  it('a newer failure wins over an older success; a newer success clears an old failure', async () => {
    const failed = await readBackupStatus(
      dir({ '.last_success': `${sec(30)}`, '.last_failure': `${sec(2)} pg_dump: connection refused` }),
      now,
      36,
    );
    expect(failed).toEqual({ state: 'failed', ageHours: 2, reason: 'pg_dump: connection refused' });
    expect(
      (
        await readBackupStatus(
          dir({ '.last_success': `${sec(1)}`, '.last_failure': `${sec(20)} old problem` }),
          now,
          36,
        )
      ).state,
    ).toBe('ok');
    expect((await readBackupStatus(dir({ '.last_failure': `${sec(1)} disk full` }), now, 36)).state).toBe('failed');
  });

  it('garbage in the heartbeat files is treated as missing, not as a crash', async () => {
    expect(await readBackupStatus(dir({ '.last_success': 'not-a-number' }), now, 36)).toEqual({ state: 'missing' });
  });
});
