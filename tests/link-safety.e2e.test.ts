import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { buildSignedInitData } from '../src/http/api/webapp-auth.js';
import { ADMIN, BOT_TOKEN, CLIENT, createHarness } from './helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('link safety: blocklist, look-alikes, Safe Browsing', () => {
  const sbCalls: Array<{ url: string; body: any }> = [];
  let sbMode: 'clean' | 'phish' | 'down' = 'clean';
  const sbFetch = (async (u: string, init: { body: string }) => {
    sbCalls.push({ url: String(u), body: JSON.parse(init.body) });
    if (sbMode === 'down') throw new Error('network down');
    return new Response(JSON.stringify(sbMode === 'phish' ? { matches: [{ threatType: 'SOCIAL_ENGINEERING' }] } : {}), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const h = url
    ? createHarness(url, { SAFE_BROWSING_API_KEY: 'test-api-key-1234567890' }, undefined, { linkSafetyFetch: sbFetch })
    : (undefined as never);
  const { db, deps, say, click, lastTo, allTo, onboard } = h ?? ({} as typeof h);
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createHttpServer({ deps: h.deps, bot: h.bot });
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await h.reset();
    sbCalls.length = 0;
    sbMode = 'clean';
    (deps.linkSafety as unknown as { cache: Map<string, unknown> }).cache.clear();
  });

  /** Заявка со ссылкой `link`; возвращает последнюю заявку или null, если ссылка отклонена. */
  async function orderWithLink(link: string) {
    await say(CLIENT, '➕ Новая заявка');
    await click(CLIENT, 'w:type:PAYMENT_LINK');
    await say(CLIENT, link);
    if (/не могу|Пришли полную|Принимаю только/.test(lastTo(CLIENT)!.text)) {
      deps.wizards.cancel(CLIENT);
      return null;
    }
    await say(CLIENT, 'Shop');
    await say(CLIENT, 'Plan');
    await say(CLIENT, '10 USD');
    await click(CLIENT, 'w:period:ONE');
    await click(CLIENT, 'w:comment:skip');
    await click(CLIENT, 'w:confirm:send');
    return db.order.findFirstOrThrow({ orderBy: { id: 'desc' } });
  }

  it('blocklist: banned domain and its subdomains are refused; unrelated domains pass; admin-only commands', async () => {
    await onboard();
    await say(ADMIN, '/domain_ban evil-shop.example.org фишинг');
    expect(lastTo(ADMIN)!.text).toMatch(/в чёрном списке/);
    await say(ADMIN, '/domain_ban evil-shop.example.org');
    expect(lastTo(ADMIN)!.text).toMatch(/уже в чёрном списке/);
    await say(ADMIN, '/banned');
    expect(lastTo(ADMIN)!.text).toMatch(/evil-shop\.example\.org — фишинг/);

    expect(await orderWithLink('https://evil-shop.example.org/pay')).toBeNull();
    expect(lastTo(CLIENT)!.text).toMatch(/Эту ссылку я принять не могу/);
    expect(lastTo(CLIENT)!.text).not.toMatch(/фишинг|чёрн/i); // причину клиенту не раскрываем
    expect(await orderWithLink('https://pay.evil-shop.example.org/x?y=1')).toBeNull();
    expect(await orderWithLink('https://good-shop.example.org/pay')).not.toBeNull();

    await say(CLIENT, '/domain_ban good-shop.example.org');
    expect(lastTo(CLIENT)!.text).toMatch(/только администратору/);
    expect(await db.blockedDomain.count()).toBe(1);

    await say(ADMIN, '/domain_unban evil-shop.example.org');
    expect(await orderWithLink('https://evil-shop.example.org/pay')).not.toBeNull();
    await say(ADMIN, '/banned');
    expect(lastTo(ADMIN)!.text).toMatch(/пуст/);
  });

  it('banning reports how many open orders already use that domain', async () => {
    await onboard();
    await orderWithLink('https://later-banned.example.org/pay');
    await say(ADMIN, '/domain_ban later-banned.example.org');
    expect(lastTo(ADMIN)!.text).toMatch(/Открытых заявок с этим доменом: 1/);
  });

  it('look-alike of a trusted domain: accepted, but the admin card shows a red warning (the client is not told)', async () => {
    await onboard();
    const o = await orderWithLink('https://paypa1.com/checkout');
    expect(o).toMatchObject({ linkRisk: 'LOOKALIKE:paypal.com' });
    const adminCard = allTo(ADMIN);
    expect(adminCard).toMatch(/ПОДОЗРИТЕЛЬНАЯ ССЫЛКА/);
    expect(adminCard).toMatch(/домен похож на доверенный paypal\.com, но им не является/);
    expect(allTo(CLIENT)).not.toMatch(/подозрительн/i);

    const clean = await orderWithLink('https://checkout.stripe.com/c/pay/abc');
    expect(clean!.linkRisk).toBeNull();
  });

  it('Safe Browsing: flags a phishing domain, sends ONLY the domain (never the path/token), caches, fails open', async () => {
    await onboard();
    sbMode = 'phish';
    const o = await orderWithLink('https://phish.example.net/pay/cs_live_SECRET_TOKEN?session=abc');
    expect(o!.linkRisk).toBe('SAFE_BROWSING:SOCIAL_ENGINEERING');
    expect(allTo(ADMIN)).toMatch(/Google Safe Browsing: фишинг \/ мошенничество/);
    expect(sbCalls).toHaveLength(1);
    expect(sbCalls[0]!.body.threatInfo.threatEntries).toEqual([{ url: 'https://phish.example.net/' }]);
    expect(JSON.stringify(sbCalls[0])).not.toMatch(/SECRET_TOKEN|session=abc/);
    expect(sbCalls[0]!.url).toContain('key=test-api-key-1234567890');

    await orderWithLink('https://phish.example.net/other'); // тот же домен — из кеша
    expect(sbCalls).toHaveLength(1);

    sbMode = 'down'; // сервис недоступен: заявку не блокируем
    const warn = vi.spyOn(deps.log, 'warn');
    const ok = await orderWithLink('https://another.example.net/pay');
    expect(ok).not.toBeNull();
    expect(ok!.linkRisk).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('test-api-key');

    sbMode = 'clean';
    expect((await orderWithLink('https://fine.example.net/pay'))!.linkRisk).toBeNull();
  });

  it('Mini App API: blocked -> 422 link_blocked; risky link is visible to admin only', async () => {
    await onboard();
    await say(ADMIN, '/domain_ban evil-shop.example.org');
    const call = async (id: number, method: 'GET' | 'POST', path: string, body?: unknown) => {
      const r = await app.inject({
        method,
        url: `/api${path}`,
        headers: { authorization: `tma ${buildSignedInitData({ id, first_name: 'U' }, BOT_TOKEN)}` },
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      return { status: r.statusCode, json: r.json() as any };
    };
    const good = { type: 'PAYMENT_LINK', service: 'Shop', description: 'Plan', amount: '10', currency: 'USD' };
    const blocked = await call(CLIENT, 'POST', '/orders', { ...good, url: 'https://evil-shop.example.org/pay' });
    expect([blocked.status, blocked.json.error]).toEqual([422, 'link_blocked']);
    expect(await db.order.count()).toBe(0);

    const risky = await call(CLIENT, 'POST', '/orders', { ...good, url: 'https://paypa1.com/checkout' });
    expect(risky.status).toBe(201);
    expect(risky.json.order.linkRisks).toEqual([]); // клиенту — пусто
    const adminView = await call(ADMIN, 'GET', `/admin/orders/${risky.json.order.id}`);
    expect(adminView.json.order.linkRisks).toEqual(['домен похож на доверенный paypal.com, но им не является']);
    expect(JSON.stringify(risky.json)).not.toContain('LOOKALIKE');
  });
});
