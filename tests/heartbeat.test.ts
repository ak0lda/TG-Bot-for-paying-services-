import { describe, expect, it, vi } from 'vitest';
import { pingHeartbeat } from '../src/services/heartbeat.js';

const SECRET = 'https://hc-ping.com/aaaa-bbbb-secret-token';
const mkLog = () => ({ warn: vi.fn() });

describe('pingHeartbeat', () => {
  it('does nothing without a URL', async () => {
    const f = vi.fn();
    expect(await pingHeartbeat(undefined, mkLog(), f as never)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('GETs the URL with a timeout and reports success', async () => {
    const f = vi.fn(async () => new Response('OK', { status: 200 }));
    expect(await pingHeartbeat(SECRET, mkLog(), f as never)).toBe(true);
    expect(f).toHaveBeenCalledWith(SECRET, expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }));
  });

  it('never throws and never logs the secret URL (bad status or network error)', async () => {
    const log = mkLog();
    expect(await pingHeartbeat(SECRET, log, (async () => new Response('no', { status: 500 })) as never)).toBe(false);
    expect(
      await pingHeartbeat(SECRET, log, (async () => {
        throw Object.assign(new Error(`fetch ${SECRET} failed`), { code: 'ECONNRESET' });
      }) as never),
    ).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-token');
  });
});
