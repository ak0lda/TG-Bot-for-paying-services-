import { describe, expect, it } from 'vitest';
import { buildSignedInitData, signInitData, validateInitData } from '../src/http/api/webapp-auth.js';

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUV';
const now = new Date('2026-10-09T12:00:00Z');
const user = { id: 42, first_name: 'Иван', username: 'ivan' };

describe('validateInitData', () => {
  it('accepts correctly signed data and returns the user', () => {
    const raw = buildSignedInitData(user, TOKEN, now);
    const r = validateInitData(raw, TOKEN, now);
    expect(r).toMatchObject({ ok: true, user });
  });

  it('signs and validates symmetrically (signInitData is the inverse of validateInitData)', () => {
    const raw = signInitData({ auth_date: '1700000000', query_id: 'AAA', user: JSON.stringify(user) }, TOKEN);
    expect(raw).toMatch(/hash=[0-9a-f]{64}/);
    expect(validateInitData(raw, TOKEN, new Date(1700000100 * 1000))).toMatchObject({ ok: true });
  });

  it('rejects a different bot token, tampered fields, missing or malformed hash', () => {
    const raw = buildSignedInitData(user, TOKEN, now);
    expect(validateInitData(raw, '999:OTHERTOKENOTHERTOKEN', now)).toEqual({ ok: false, reason: 'bad_hash' });

    const tampered = raw.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":1'));
    expect(tampered).not.toBe(raw);
    expect(validateInitData(tampered, TOKEN, now)).toEqual({ ok: false, reason: 'bad_hash' });

    const noHash = new URLSearchParams(raw);
    noHash.delete('hash');
    expect(validateInitData(noHash.toString(), TOKEN, now)).toEqual({ ok: false, reason: 'no_hash' });
    expect(validateInitData(raw.replace(/hash=[0-9a-f]+/, 'hash=zz'), TOKEN, now)).toEqual({ ok: false, reason: 'no_hash' });
    expect(validateInitData('', TOKEN, now)).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects an extra unsigned field (cannot be smuggled in)', () => {
    const raw = `${buildSignedInitData(user, TOKEN, now)}&start_param=evil`;
    expect(validateInitData(raw, TOKEN, now)).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('enforces auth_date freshness', () => {
    const old = buildSignedInitData(user, TOKEN, new Date('2026-10-07T12:00:00Z'));
    expect(validateInitData(old, TOKEN, now)).toEqual({ ok: false, reason: 'expired' });
    expect(validateInitData(old, TOKEN, now, 3 * 86_400)).toMatchObject({ ok: true });
    const future = buildSignedInitData(user, TOKEN, new Date('2026-10-09T13:00:00Z'));
    expect(validateInitData(future, TOKEN, now)).toEqual({ ok: false, reason: 'future' });
    const noDate = signInitData({ user: JSON.stringify(user) }, TOKEN);
    expect(validateInitData(noDate, TOKEN, now)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects malformed user payloads', () => {
    const fields = (u: string) => signInitData({ auth_date: String(now.getTime() / 1000), user: u }, TOKEN);
    expect(validateInitData(fields('not json'), TOKEN, now)).toEqual({ ok: false, reason: 'no_user' });
    expect(validateInitData(fields('{"id":-1,"first_name":"x"}'), TOKEN, now)).toEqual({ ok: false, reason: 'no_user' });
    expect(validateInitData(fields('{"id":5}'), TOKEN, now)).toEqual({ ok: false, reason: 'no_user' });
    expect(validateInitData(signInitData({ auth_date: String(now.getTime() / 1000) }, TOKEN), TOKEN, now)).toEqual({ ok: false, reason: 'no_user' });
  });
});
