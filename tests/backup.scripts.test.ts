import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapDefaults } from '../src/db/bootstrap.js';
import { createDb } from '../src/db/client.js';
import { readBackupStatus } from '../src/services/backup-health.js';

// Настоящие скрипты backup/backup.sh и scripts/restore-backup.sh против настоящего PostgreSQL и age.
// Нужны: TEST_DATABASE_URL (БД с миграциями), age, pg_dump, psql, gunzip.
const url = process.env.TEST_DATABASE_URL;
const has = (bin: string) => spawnSync('which', [bin]).status === 0;
const tools = ['age', 'age-keygen', 'pg_dump', 'psql', 'gunzip'].every(has);

describe.skipIf(!url || !tools)('encrypted backup scripts', () => {
  const root = resolve(import.meta.dirname, '..');
  const work = mkdtempSync(join(tmpdir(), 'bk-test-'));
  const u = url ? new URL(url) : new URL('postgresql://x@localhost/x');
  const dbName = u.pathname.slice(1);
  const base = `${u.protocol}//${u.username ? `${u.username}@` : ''}${u.host}`;
  let recipient = '';
  let keyFile = '';

  const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    POSTGRES_HOST: u.hostname,
    POSTGRES_PORT: u.port || '5432',
    POSTGRES_USER: u.username,
    POSTGRES_DB: dbName,
    BACKUP_AGE_RECIPIENT: recipient,
    BACKUP_KEEP_DAYS: '14',
    ...over,
  });
  const run = (cmd: string, args: string[], e: NodeJS.ProcessEnv) =>
    spawnSync('bash', [cmd, ...args], { env: e, encoding: 'utf8' });
  const backup = (dir: string, over: Record<string, string> = {}) =>
    run(join(root, 'backup/backup.sh'), [], env({ BACKUP_DIR: dir, ...over }));
  const newDir = () => mkdtempSync(join(work, 'out-'));
  const files = (dir: string) => readdirSync(join(dir, 'daily')).filter((f) => f.endsWith('.age'));

  beforeAll(async () => {
    const gen = spawnSync('age-keygen', ['-o', join(work, 'key.txt')], { encoding: 'utf8' });
    keyFile = join(work, 'key.txt');
    recipient = /Public key: (age1\w+)/.exec(gen.stderr + gen.stdout)![1]!;
    const db = createDb(url!);
    await bootstrapDefaults(db); // в БД точно есть данные
    await db.$disconnect();
  });
  afterAll(() => undefined);

  it('produces an encrypted dump that is unreadable without the key and restores into an empty DB', () => {
    const dir = newDir();
    const r = backup(dir);
    expect(r.status, r.stderr).toBe(0);
    const [file] = files(dir);
    expect(file).toMatch(new RegExp(`^${dbName}-\\d{8}-\\d{6}\\.sql\\.gz\\.age$`));
    const raw = readFileSync(join(dir, 'daily', file!));
    expect(raw.includes(Buffer.from('CREATE TABLE'))).toBe(false);
    expect(raw.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(false); // это не просто gzip
    expect(raw.includes(Buffer.from('PaymentMethod'))).toBe(false);
    expect(readdirSync(join(dir, 'daily')).some((f) => f.startsWith('.tmp-'))).toBe(false); // временных файлов не осталось

    const dumped = spawnSync('bash', ['-c', `age -d -i "${keyFile}" "${join(dir, 'daily', file!)}" | gunzip`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(dumped.stdout).toContain('CREATE TABLE public."User"');

    // восстановление в чистую БД + проверка
    const target = `bk_restore_${process.pid}`;
    spawnSync('psql', [`${base}/postgres`, '-qc', `DROP DATABASE IF EXISTS "${target}"`]);
    expect(spawnSync('psql', [`${base}/postgres`, '-qc', `CREATE DATABASE "${target}"`]).status).toBe(0);
    try {
      const restore = run(
        join(root, 'scripts/restore-backup.sh'),
        [join(dir, 'daily', file!), keyFile, `${base}/${target}`],
        process.env,
      );
      expect(restore.status, restore.stderr).toBe(0);
      const count = (db: string) =>
        spawnSync('psql', ['-At', `${base}/${db}`, '-c', 'SELECT count(*) FROM "PaymentMethod"'], {
          encoding: 'utf8',
        }).stdout.trim();
      expect(count(target)).toBe(count(dbName));
      // во второй раз — отказ: база не пуста
      const again = run(
        join(root, 'scripts/restore-backup.sh'),
        [join(dir, 'daily', file!), keyFile, `${base}/${target}`],
        process.env,
      );
      expect(again.status).toBe(3);
      expect(again.stderr).toMatch(/только в пустую/);
      // verify-скрипт проходит
      const verify = run(
        join(root, 'scripts/verify-encrypted-backup.sh'),
        [join(dir, 'daily', file!), keyFile, base],
        process.env,
      );
      expect(verify.status, verify.stderr).toBe(0);
      expect(verify.stdout).toMatch(/бэкап пригоден/);
    } finally {
      spawnSync('psql', [`${base}/postgres`, '-qc', `DROP DATABASE IF EXISTS "${target}"`]);
    }
  });

  it('writes the heartbeat the bot reads', async () => {
    const dir = newDir();
    expect(backup(dir).status).toBe(0);
    const status = await readBackupStatus(dir, new Date(), 36);
    expect(status).toEqual({ state: 'ok', ageHours: 0 });
    expect(readFileSync(join(dir, '.last_success'), 'utf8')).toMatch(/^\d+ .+\.sql\.gz\.age \d+$/m);
  });

  it('a failing dump reports the failure without leaking the password and without leaving partial files', async () => {
    const dir = newDir();
    const r = backup(dir, { POSTGRES_DB: 'no_such_database', POSTGRES_PASSWORD: 's3cr3t-password' });
    expect(r.status).toBe(1);
    const failure = readFileSync(join(dir, '.last_failure'), 'utf8');
    expect(failure).toMatch(/^\d+ pg_dump failed/);
    expect(failure + r.stderr + r.stdout).not.toContain('s3cr3t-password');
    expect(files(dir)).toEqual([]);
    expect(existsSync(join(dir, '.last_success'))).toBe(false);
    expect(await readBackupStatus(dir, new Date(), 36)).toMatchObject({ state: 'failed', reason: 'pg_dump failed' });
  });

  it('bad recipient: encryption fails cleanly (no plaintext dump left behind)', () => {
    const dir = newDir();
    const r = backup(dir, { BACKUP_AGE_RECIPIENT: 'not-a-key' });
    expect(r.status).toBe(1);
    expect(readFileSync(join(dir, '.last_failure'), 'utf8')).toMatch(/encryption failed/);
    expect(readdirSync(join(dir, 'daily'))).toEqual([]);
  });

  it('requires a recipient: refuses to run without encryption', () => {
    const dir = newDir();
    const e = env({ BACKUP_DIR: dir });
    delete e.BACKUP_AGE_RECIPIENT;
    const r = run(join(root, 'backup/backup.sh'), [], e);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(dir, 'daily'))).toBe(false); // даже каталог не создан: без шифрования дамп не делается
    expect(existsSync(join(dir, '.last_success'))).toBe(false);
  });

  it('local retention removes only old encrypted backups', () => {
    const dir = newDir();
    mkdirSync(join(dir, 'daily'));
    const old = join(dir, 'daily', 'bot-20200101-000000.sql.gz.age');
    const recent = join(dir, 'daily', 'bot-20991231-000000.sql.gz.age');
    const other = join(dir, 'daily', 'notes.txt');
    for (const f of [old, recent, other]) writeFileSync(f, 'x');
    const longAgo = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(other, longAgo, longAgo);
    expect(backup(dir).status).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('copies the (already encrypted) file offsite via rclone; an upload failure is reported and the local copy is kept', async () => {
    const shimDir = mkdtempSync(join(work, 'shim-'));
    const remoteDir = mkdtempSync(join(work, 'remote-'));
    const log = join(shimDir, 'calls.log');
    const shim = join(shimDir, 'rclone');
    writeFileSync(
      shim,
      `#!/bin/bash\necho "$@" >> "${log}"\nif [ "$1" = copyto ]; then [ -n "$FAIL_UPLOAD" ] && exit 1; cp "$2" "${remoteDir}/$(basename "$3")"; fi\nexit 0\n`,
    );
    chmodSync(shim, 0o755);
    const withShim = { PATH: `${shimDir}:${process.env.PATH}`, BACKUP_RCLONE_REMOTE: 'offsite:bucket/bot' };

    const ok = newDir();
    expect(backup(ok, withShim).status).toBe(0);
    const uploaded = readdirSync(remoteDir);
    expect(uploaded).toEqual(files(ok));
    expect(readFileSync(join(remoteDir, uploaded[0]!)).equals(readFileSync(join(ok, 'daily', files(ok)[0]!)))).toBe(
      true,
    );
    expect(readFileSync(log, 'utf8')).toMatch(/delete --min-age 14d/); // ротация на удалённой стороне

    const bad = newDir();
    const r = backup(bad, { ...withShim, FAIL_UPLOAD: '1' });
    expect(r.status).toBe(1);
    expect(readFileSync(join(bad, '.last_failure'), 'utf8')).toMatch(/offsite upload failed/);
    expect(files(bad)).toHaveLength(1); // локальная копия сохранена
    expect(await readBackupStatus(bad, new Date(), 36)).toMatchObject({ state: 'failed' });
  });

  it('pings the external heartbeat only after a successful backup, tolerates a failing ping, and never prints the URL', () => {
    const shimDir = mkdtempSync(join(work, 'curl-'));
    const log = join(shimDir, 'curl.log');
    const shim = join(shimDir, 'curl');
    writeFileSync(shim, `#!/bin/bash\necho "$@" >> "${log}"\n[ -n "$FAIL_PING" ] && exit 22\nexit 0\n`);
    chmodSync(shim, 0o755);
    const url = 'https://hc-ping.com/very-secret-token';
    const base2 = { PATH: `${shimDir}:${process.env.PATH}`, BACKUP_HEARTBEAT_URL: url };

    const ok = newDir();
    const r1 = backup(ok, base2);
    expect(r1.status, r1.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain(url);
    expect(r1.stdout + r1.stderr).not.toContain('very-secret-token');

    // неудачный пинг не ломает бэкап
    const flaky = newDir();
    const r2 = backup(flaky, { ...base2, FAIL_PING: '1' });
    expect(r2.status).toBe(0);
    expect(r2.stderr).toMatch(/heartbeat ping failed/);
    expect(r2.stdout + r2.stderr).not.toContain('very-secret-token');

    // неудачный бэкап — пинга нет (иначе мониторинг не заметит проблему)
    const before = readFileSync(log, 'utf8').split('\n').length;
    const bad = newDir();
    expect(backup(bad, { ...base2, POSTGRES_DB: 'no_such_database' }).status).toBe(1);
    expect(readFileSync(log, 'utf8').split('\n').length).toBe(before);
  });
});
