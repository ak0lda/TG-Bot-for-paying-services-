/**
 * Дымовой тест Mini App в настоящем браузере (Chromium через playwright-core).
 * Поднимает бота с подставным Telegram API и реальной БД, раздаёт webapp/dist и проходит основные экраны
 * клиента и админа с подписанным initData. Скриншоты — в SHOTS_DIR.
 *
 *   pnpm --filter webapp build
 *   TEST_DATABASE_URL=postgresql://... SHOTS_DIR=/tmp/shots pnpm tsx scripts/webapp-smoke.ts
 *
 * ВНИМАНИЕ: БД очищается.
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import { createHttpServer } from '../src/http/server.js';
import { buildSignedInitData } from '../src/http/api/webapp-auth.js';
import { ADMIN, BOT_TOKEN, CLIENT, createHarness } from '../tests/helpers/harness.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('set TEST_DATABASE_URL');
const shots = process.env.SHOTS_DIR ?? '/tmp/webapp-shots';
mkdirSync(shots, { recursive: true });
const PORT = 3999;
const chromePath = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const problems: string[] = [];
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    problems.push(msg);
    console.error('✘', msg);
  } else console.log('✔', msg);
};

async function main() {
  const h = createHarness(url!);
  await h.reset();
  await h.onboard();
  const app = await createHttpServer({ deps: h.deps, bot: h.bot });
  await app.listen({ port: PORT, host: '127.0.0.1' });

  const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });

  const open = async (tgId: number, name: string) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    // Эмуляция среды Telegram (мобильный клиент): SDK отправляет события в TelegramWebviewProxy.
    await page.addInitScript('window.TelegramWebviewProxy = { postEvent: function () {} };');
    if (process.env.DEBUG_BROWSER) page.on('console', (m) => console.log(`[${name}] ${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));
    // 4xx на проверках валидации ожидаемы; браузер пишет их в консоль как «Failed to load resource».
    page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && problems.push(`[${name}] console: ${m.text()}`));
    page.on('response', (r) => r.status() >= 500 && problems.push(`[${name}] HTTP ${r.status()} ${r.url()}`));
    const initData = buildSignedInitData({ id: tgId, first_name: name }, BOT_TOKEN);
    const theme = encodeURIComponent(JSON.stringify({ bg_color: '#ffffff', text_color: '#1c1c1e', button_color: '#2481cc', button_text_color: '#ffffff', secondary_bg_color: '#f2f2f7' }));
    await page.goto(`http://127.0.0.1:${PORT}/app/#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0&tgWebAppPlatform=android&tgWebAppThemeParams=${theme}`);
    return page;
  };
  const shot = (p: Page, n: string) => p.screenshot({ path: `${shots}/${n}.png`, fullPage: true });
  const text = (p: Page) => p.locator('body').innerText();

  // ── Вне Telegram ────────────────────────────────────────────
  const bare = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  await bare.goto(`http://127.0.0.1:${PORT}/app/`);
  await bare.waitForSelector('.errbox');
  ok((await text(bare)).includes('Откройте приложение из Telegram'), 'вне Telegram: понятное сообщение');
  await shot(bare, '00-outside-telegram');

  // ── Клиент ──────────────────────────────────────────────────
  const c = await open(CLIENT, 'Вася');
  await c.waitForSelector('text=Заявок пока нет', { timeout: 8000 }).catch(async (e) => {
    console.error('Текст страницы клиента:', JSON.stringify(await text(c)));
    await shot(c, 'debug-client');
    throw e;
  });
  ok(true, 'клиент: пустой список заявок');
  await shot(c, '01-client-empty');

  await c.click('nav >> text=Новая');
  await c.fill('input[placeholder="https://…"]', 'https://bit.ly/abc');
  await c.fill('input[placeholder="Netflix"]', 'Netflix');
  await c.fill('textarea >> nth=0', 'Premium');
  await c.fill('input[placeholder="15,99"]', '10');
  await c.click('text=Отправить заявку');
  await c.waitForSelector('text=Сокращённые ссылки');
  ok(true, 'клиент: сокращённая ссылка отклонена, ошибка у поля');
  await shot(c, '02-client-form-error');

  await c.fill('input[placeholder="https://…"]', 'https://checkout.stripe.com/c/pay/abc');
  await c.click('button:has-text("Месяц")');
  await c.click('text=Отправить заявку');
  await c.waitForSelector('h1:has-text("Заявка #1")');
  ok((await text(c)).includes('Новая'), 'клиент: заявка создана, открыта карточка');
  await shot(c, '03-client-order-new');

  // ── Админ ───────────────────────────────────────────────────
  const a = await open(ADMIN, 'Админ');
  await a.waitForSelector('text=Netflix');
  ok((await text(a)).includes('✅'), 'админ: очередь, доверенный домен помечен');
  await shot(a, '04-admin-queue');
  await a.click('text=Netflix');
  await a.waitForSelector('text=Доверенный домен');
  await shot(a, '05-admin-order');
  await a.click('button:has-text("Рассчитать")');
  await a.waitForSelector('text=Рассчитана');
  ok((await text(a)).includes('964'), 'админ: расчёт 964 ₽');
  await shot(a, '06-admin-quoted');

  // ── Клиент подтверждает и «оплачивает» (Наличные: чек не нужен) ─
  await c.click('nav >> text=Заявки');
  await c.click('text=Netflix');
  await c.waitForSelector('text=Подтвердить расчёт');
  await shot(c, '07-client-quoted');
  await c.click('button:has-text("Подтвердить расчёт")');
  await c.waitForSelector('text=Ждём реквизиты');
  ok(true, 'клиент: расчёт подтверждён, способ не выбирается — ждём реквизиты от админа');
  await shot(c, '08-client-awaiting-requisites');

  // Админ выбирает способ и присылает реквизиты прямо из приложения.
  await a.reload();
  await a.click('text=Netflix');
  await a.waitForSelector('text=Реквизиты клиенту');
  await a.selectOption('select', { label: 'Наличные' });
  await a.fill('textarea', 'Передам наличными при встрече');
  await shot(a, '08b-admin-requisites');
  await a.click('button:has-text("Отправить реквизиты")');
  await a.waitForSelector('text=Отправлено: Наличные');
  ok(true, 'админ: реквизиты отправлены из приложения');

  await c.reload();
  await c.click('text=Netflix');
  await c.waitForSelector('button:has-text("Я оплатил")');
  await c.click('button:has-text("Я оплатил")');
  await c.waitForSelector('text=Проверка оплаты');
  ok(true, 'клиент: после реквизитов → оплата → проверка');
  await shot(c, '09-client-payment-check');

  await a.reload();
  await a.click('text=Netflix');
  await a.waitForSelector('text=Оплата получена');
  await a.click('button:has-text("Оплата получена")');
  await a.waitForSelector('text=В работе');
  await a.click('button:has-text("Выполнено")');
  await a.fill('input[placeholder="10,50"]', '10,50');
  await shot(a, '10-admin-complete-form');
  await a.locator('button:has-text("Выполнено")').click();
  await a.waitForSelector('text=Выполнена');
  ok(true, 'админ: оплата подтверждена → выполнено');
  await shot(a, '11-admin-done');

  await a.click('nav >> text=Статистика');
  await a.waitForSelector('text=Валовая прибыль');
  ok((await text(a)).includes('964'), 'админ: статистика показывает оборот');
  await shot(a, '12-admin-stats');

  await c.click('nav >> text=Баланс');
  await c.waitForSelector('text=Операции');
  ok((await text(c)).includes('Долг'), 'клиент: доплата по факту отражена долгом на экране баланса');
  await shot(c, '13-client-balance');

  // ── Защита: клиентский initData не открывает админку ────────
  // Код как строка: tsx добавляет в функции хелпер __name, которого нет в браузере.
  const status = await c.evaluate(`(async () => {
    const raw = decodeURIComponent(location.hash.split('tgWebAppData=')[1].split('&tgWebApp')[0]);
    const r = await fetch('/api/admin/orders', { headers: { Authorization: 'tma ' + raw } });
    return r.status;
  })()`) as number;
  ok(status === 403, `клиент не получает /api/admin/* (HTTP ${status})`);

  await browser.close();
  await app.close();
  await h.db.$disconnect();

  if (problems.length) {
    console.error(`\nПроблемы (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`\nГотово. Скриншоты: ${shots}`);
}

main().catch((e) => {
  console.error(e);
  if (problems.length) console.error('Собранные проблемы:\n- ' + problems.join('\n- '));
  process.exit(1);
});
