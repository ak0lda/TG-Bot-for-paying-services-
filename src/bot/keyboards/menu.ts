import { Keyboard } from 'grammy';
import { b } from '../../texts/balance.js';
import { o as ot } from '../../texts/orders.js';

export const clientMenu = new Keyboard()
  .text(ot.btnNew).text(ot.btnMy).row()
  .text(b.btnBalance).text(b.btnTopUp)
  .resized()
  .persistent();
