import { Keyboard } from 'grammy';
import { o as ot } from '../../texts/orders.js';

export const clientMenu = new Keyboard().text(ot.btnNew).text(ot.btnMy).resized().persistent();
