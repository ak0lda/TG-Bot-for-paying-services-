import type { PayMode, PaymentMethod } from '@prisma/client';
import type { BotContext, Deps } from '../context.js';
import type { WizardDef } from './engine.js';
import { linkInput } from './helpers.js';
import { handleOrderError } from '../errors.js';
import { formatRub } from '../../domain/money.js';
import { availableOf } from '../../domain/ledger.js';
import { balanceOf } from '../../services/ledger-service.js';
import { PayLaterDeniedError, PayLaterLimitError, type OrderWithClient } from '../../services/order-service.js';
import { o as ot } from '../../texts/orders.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

// ── Подтверждение расчёта (QUOTED -> AWAITING_PAYMENT | IN_PROGRESS) ─────
interface ConfirmData {
  orderId: number;
  version: number;
  clientId: number;
  payMode: PayMode;
  /** Нехватка баланса для BALANCE (по состоянию на старт диалога; окончательно считается в транзакции). */
  shortfall: bigint;
  needsTransfer: boolean;
  balance: bigint;
  methodId: number | null;
  methods: PaymentMethod[];
}

export async function startConfirm(ctx: BotContext, deps: Deps, order: OrderWithClient): Promise<void> {
  const total = order.totalMinor ?? 0n;
  const balance = await balanceOf(deps.db, order.clientId);
  const shortfall = order.payMode === 'BALANCE' ? total - (availableOf(balance) < total ? availableOf(balance) : total) : 0n;
  const needsTransfer = order.payMode === 'PREPAY' || (order.payMode === 'BALANCE' && shortfall > 0n);
  const methods = needsTransfer ? await deps.catalog.listMethods(true) : [];
  if (needsTransfer && methods.length === 0) return void (await ctx.reply(ot.noMethods));
  const data: ConfirmData = {
    orderId: order.id,
    version: order.version,
    clientId: order.clientId,
    payMode: order.payMode,
    shortfall,
    needsTransfer,
    balance,
    methodId: methods.length === 1 ? methods[0]!.id : null,
    methods,
  };
  await deps.wizards.start(ctx, confirmWizard(deps), data);
}

function confirmWizard(deps: Deps): WizardDef<ConfirmData> {
  return {
    name: 'confirm',
    steps: [
      {
        key: 'short',
        skip: (d) => !(d.payMode === 'BALANCE' && d.shortfall > 0n),
        prompt: (d) => ({
          text: ot.shortfallPrompt(formatRub(availableOf(d.balance)), formatRub(d.shortfall)),
          buttons: [[{ label: ot.shortfallBtn(formatRub(d.shortfall)), value: 'ok' }]],
        }),
        handle: async (input) => (input.button === 'ok' ? undefined : ot.useButtons),
      },
      {
        key: 'method',
        skip: (d) => !d.needsTransfer || d.methodId !== null,
        prompt: (d) => ({
          text: ot.chooseMethod,
          buttons: d.methods.map((m) => [{ label: m.title, value: String(m.id) }]),
        }),
        handle: async (input, d) => {
          const m = d.methods.find((x) => String(x.id) === input.button);
          if (!m) return ot.useButtons;
          d.methodId = m.id;
          return undefined;
        },
      },
    ],
    finish: async (ctx, d) => {
      try {
        const { expired, order } = await deps.orders.confirmQuote(d.orderId, d.version, d.clientId, d.methodId);
        const view = await deps.presenter.client(order);
        if (expired) {
          return void (await ctx.reply(`${ot.expiredNow}\n\n${view.text}`, { ...html, reply_markup: view.keyboard }));
        }
        if (order.status === 'IN_PROGRESS') {
          const how = ot.payModeShort[order.payMode];
          await ctx.reply(`${ot.confirmedInProgress(order.id, how)}\n\n${view.text}`, { ...html, reply_markup: view.keyboard });
          await deps.presenter.notifyAdmin(order, ot.adminInProgress(order.id, how));
          return;
        }
        await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
      } catch (e) {
        if (e instanceof PayLaterDeniedError) return void (await ctx.reply(ot.payLaterDenied));
        if (e instanceof PayLaterLimitError) {
          return void (await ctx.reply(ot.payLaterLimit(formatRub(e.limitMinor), formatRub(e.exposureMinor)), html));
        }
        if (!(await handleOrderError(ctx, deps, e, d.orderId))) throw e;
      }
    },
  };
}

// ── «Я оплатил» (AWAITING_PAYMENT -> PAYMENT_CHECK) ─────────────────────
interface PaidData {
  orderId: number;
  version: number;
  clientId: number;
  needsReceipt: boolean;
  receipt?: { fileId: string; fileType: 'photo' | 'document' };
}

export async function startPaid(ctx: BotContext, deps: Deps, order: OrderWithClient): Promise<void> {
  const method = order.payMethodId ? await deps.catalog.getMethod(order.payMethodId) : null;
  await deps.wizards.start(ctx, paidWizard(deps), {
    orderId: order.id,
    version: order.version,
    clientId: order.clientId,
    needsReceipt: method ? method.requiresReceipt : true,
  } satisfies PaidData);
}

function paidWizard(deps: Deps): WizardDef<PaidData> {
  return {
    name: 'paid',
    steps: [
      {
        key: 'receipt',
        skip: (d) => !d.needsReceipt,
        prompt: () => ({ text: ot.sendReceipt }),
        handle: async (input, d) => {
          if (!input.file) return ot.needFile;
          d.receipt = { fileId: input.file.id, fileType: input.file.type };
          return undefined;
        },
      },
    ],
    finish: async (ctx, d) => {
      try {
        const order = await deps.orders.markPaid(d.orderId, d.version, d.clientId, d.receipt);
        await ctx.reply(ot.paidAccepted(order.id), html);
        if (d.receipt) await deps.notifier.attachmentToAdmin(d.receipt, `Чек по заявке #${order.id}`);
        await deps.presenter.notifyAdmin(order, ot.adminPaid(order.id));
      } catch (e) {
        if (!(await handleOrderError(ctx, deps, e, d.orderId))) throw e;
      }
    },
  };
}

// ── Новая ссылка (LINK_INVALID -> IN_PROGRESS) ───────────────────────────
interface NewLinkData {
  orderId: number;
  version: number;
  clientId: number;
  url?: string;
  domain?: string;
}

export async function startNewLink(ctx: BotContext, deps: Deps, order: OrderWithClient): Promise<void> {
  await deps.wizards.start(ctx, newLinkWizard(deps), {
    orderId: order.id,
    version: order.version,
    clientId: order.clientId,
  } satisfies NewLinkData);
}

function newLinkWizard(deps: Deps): WizardDef<NewLinkData> {
  return {
    name: 'newlink',
    steps: [
      {
        key: 'url',
        prompt: () => ({ text: ot.stepUrl(false) }),
        handle: async (input, d) => {
          const res = await linkInput(input, deps);
          if (!res.ok) return res.error;
          d.url = res.value.url;
          d.domain = res.value.domain;
          return undefined;
        },
      },
    ],
    finish: async (ctx, d) => {
      try {
        const order = await deps.orders.submitNewLink(d.orderId, d.version, d.clientId, d.url!, d.domain!);
        await ctx.reply(ot.newLinkAccepted, html);
        await deps.presenter.notifyAdmin(order, ot.adminNewLink(order.id));
      } catch (e) {
        if (!(await handleOrderError(ctx, deps, e, d.orderId))) throw e;
      }
    },
  };
}

