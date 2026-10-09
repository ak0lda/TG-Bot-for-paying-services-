import { Keyboard } from 'grammy';
import { b } from '../../texts/balance.js';
import { o as ot } from '../../texts/orders.js';

/** Меню клиента. Если задан WEBAPP_URL — добавляется кнопка Mini App. */
export function buildClientMenu(webAppUrl?: string): Keyboard {
  const kb = new Keyboard().text(ot.btnNew).text(ot.btnMy).row().text(b.btnBalance).text(b.btnTopUp);
  if (webAppUrl) kb.row().webApp(ot.btnApp, webAppUrl);
  return kb.resized().persistent();
}
