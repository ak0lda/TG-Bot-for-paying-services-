import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type BackupStatus =
  | { state: 'ok'; ageHours: number }
  | { state: 'stale'; ageHours: number }
  | { state: 'failed'; ageHours: number; reason: string }
  | { state: 'missing' };

const readText = (p: string): Promise<string | null> => readFile(p, 'utf8').then((t) => t.trim(), () => null);

/**
 * Состояние бэкапов по «сердцебиению», которое пишет контейнер backup:
 *  .last_success — Unix-время (секунды) последнего удачного бэкапа в первой строке;
 *  .last_failure — Unix-время и краткая причина (одна строка) последней неудачи.
 * failed — если неудача новее успеха; stale — если последний успех старше maxAgeHours.
 */
export async function readBackupStatus(dir: string, now: Date, maxAgeHours: number): Promise<BackupStatus> {
  const [okRaw, failRaw] = await Promise.all([readText(join(dir, '.last_success')), readText(join(dir, '.last_failure'))]);
  const ok = okRaw ? Number(okRaw.split(/\s/)[0]) : NaN;
  const fail = failRaw ? Number(failRaw.split(/\s/)[0]) : NaN;
  const nowSec = Math.floor(now.getTime() / 1000);
  const age = (t: number) => Math.max(0, Math.floor((nowSec - t) / 3600));

  if (Number.isFinite(fail) && (!Number.isFinite(ok) || fail > ok)) {
    return { state: 'failed', ageHours: age(fail), reason: (failRaw ?? '').split(/\s+/).slice(1).join(' ').slice(0, 160) || 'unknown' };
  }
  if (!Number.isFinite(ok)) return { state: 'missing' };
  return age(ok) > maxAgeHours ? { state: 'stale', ageHours: age(ok) } : { state: 'ok', ageHours: age(ok) };
}
