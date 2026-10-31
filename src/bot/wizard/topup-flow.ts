import { InlineKeyboard } from 'grammy';
import { MoneyParseError as CryptoMoneyParseError, parseUsdtInput } from '../../domain/crypto-invoice.js';
import { RateUnavailableError } from '../../services/rates.js';
import { cx } from '../../texts/crypto.js';
import type { BotContext, Deps } from '../context.js';
import type { WizardDef } from './engine.js';
import { notifyAdminTopUp } from '../requisites.js';
import { findDuplicateReceipts } from '../../services/receipts.js';
import { autoSendTopUpRequisites } from '../auto-requisites.js';
import { debtOf } from '../../domain/ledger.js';
import { MoneyParseError, parseDecimalToMinor } from '../../domain/money.js';
import { balanceOf } from '../../services/ledger-service.js';
import type { Attached } from '../../services/order-service.js';
import { TopUpNotPendingError } from '../../services/topup-service.js';
import { b } from '../../texts/balance.js';
import { o as ot } from '../../texts/orders.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const MIN_MINOR = 100n; // 1 ₽
const MAX_MINOR = 1_000_000_000n; // 10 000 000 ₽

// ── Заявка на пополнение: клиент называет сумму, реквизиты присылает админ ──
interface TopUpData {
  clientId: number;
  debt: bigint;
  amountMinor?: bigint;
  kind?: 'rub' | 'usdt';
  usdtMicro?: bigint;
  cryptoOn: boolean;
}

export async function startTopUp(ctx: BotContext, deps: Deps, opts: { repayDebt?: boolean } = {}): Promise<void> {
  const clientId = ctx.appUser!.id;
  const debt = debtOf(await balanceOf(deps.db, clientId));
  deps.wizards.cancel(ctx.from!.id);
  await deps.wizards.start(ctx, topUpWizard(deps), {
    clientId,
    debt,
    cryptoOn: deps.crypto.enabled,
    ...(opts.repayDebt && debt > 0n ? { amountMinor: debt } : {}),
  } satisfies TopUpData);
}

function topUpWizard(deps: Deps): WizardDef<TopUpData> {
  return {
    name: 'topup',
    steps: [
      {
        key: 'kind',
        skip: (d) => !d.cryptoOn || d.amountMinor !== undefined || d.kind !== undefined,
        prompt: () => ({
          text: cx.kindPrompt,
          buttons: [[{ label: cx.kindRub, value: 'rub' }], [{ label: cx.kindUsdt, value: 'usdt' }]],
        }),
        handle: async (input, d) => {
          if (input.button !== 'rub' && input.button !== 'usdt') return cx.kindPrompt;
          d.kind = input.button;
          return undefined;
        },
      },
      {
        key: 'usdt-amount',
        skip: (d) => d.kind !== 'usdt',
        prompt: async () => {
          const s = await deps.settings.getAll();
          return { text: cx.usdtAmountPrompt(s.cryptoMinUsdt, s.cryptoMaxUsdt) };
        },
        handle: async (input, d) => {
          const s = await deps.settings.getAll();
          try {
            const micro = parseUsdtInput(input.text ?? '');
            if (micro < BigInt(s.cryptoMinUsdt) * 1_000_000n || micro > BigInt(s.cryptoMaxUsdt) * 1_000_000n)
              return cx.usdtLimit(s.cryptoMinUsdt, s.cryptoMaxUsdt);
            d.usdtMicro = micro;
            return undefined;
          } catch (e) {
            if (e instanceof CryptoMoneyParseError) return cx.usdtBadAmount;
            throw e;
          }
        },
      },
      {
        key: 'amount',
        skip: (d) => d.amountMinor !== undefined || d.kind === 'usdt',
        prompt: (d) => ({
          text: b.stepAmount(d.debt),
          buttons: d.debt > 0n ? [[{ label: b.repayBtn(d.debt), value: 'debt' }]] : [],
        }),
        handle: async (input, d) => {
          if (input.button === 'debt') {
            d.amountMinor = d.debt;
            return undefined;
          }
          try {
            const minor = parseDecimalToMinor(input.text ?? '');
            if (minor < MIN_MINOR || minor > MAX_MINOR) return b.amountLimit;
            d.amountMinor = minor;
            return undefined;
          } catch (e) {
            if (e instanceof MoneyParseError) return b.badAmount;
            throw e;
          }
        },
      },
    ],
    finish: async (ctx, d) => {
      if (d.kind === 'usdt') {
        try {
          const inv = await deps.crypto.createInvoice(d.clientId, d.usdtMicro!);
          const s = await deps.settings.getAll();
          const expires = new Intl.DateTimeFormat('ru-RU', {
            timeZone: deps.config.TIMEZONE,
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }).format(inv.expiresAt!);
          deps.log.info({ topUpId: inv.id }, 'usdt invoice created');
          await ctx.reply(
            cx.invoice({
              id: inv.id,
              address: deps.crypto.address,
              amountMicro: inv.cryptoAmountMicro!,
              creditMinor: inv.amountMinor,
              rateScaled: inv.cryptoRateScaled!,
              feeBp: s.cryptoFeeBp,
              expires,
            }),
            { ...html, reply_markup: new InlineKeyboard().text(cx.cancelBtn, `cc:${inv.id}`) },
          );
        } catch (e) {
          if (e instanceof RateUnavailableError) return void (await ctx.reply(cx.rateUnavailable));
          throw e;
        }
        return;
      }
      const topUp = await deps.topups.create(d.clientId, d.amountMinor!);
      deps.log.info({ topUpId: topUp.id }, 'top-up requested');
      const auto = await autoSendTopUpRequisites(deps, topUp);
      if (auto.sent) {
        await notifyAdminTopUp(deps, auto.topUp, b.adminAutoTopUp(topUp.id, auto.method.title, topUp.amountMinor));
        return;
      }
      await ctx.reply(b.topUpRequested(topUp.id, topUp.amountMinor), html);
      await notifyAdminTopUp(
        deps,
        topUp,
        auto.hadCandidates ? b.adminAutoTopUpMiss(topUp.id, topUp.amountMinor) : undefined,
      );
    },
  };
}

// ── Чек по пополнению: клиент присылает после того, как получил реквизиты ──
interface ReceiptData {
  topUpId: number;
  clientId: number;
  receipt?: Attached;
}

export async function startTopUpReceipt(ctx: BotContext, deps: Deps, topUpId: number): Promise<void> {
  deps.wizards.cancel(ctx.from!.id);
  await deps.wizards.start(ctx, receiptWizard(deps), { topUpId, clientId: ctx.appUser!.id } satisfies ReceiptData);
}

function receiptWizard(deps: Deps): WizardDef<ReceiptData> {
  return {
    name: 'topup-receipt',
    steps: [
      {
        key: 'file',
        prompt: () => ({ text: b.receiptPrompt }),
        handle: async (input, d) => {
          if (!input.file) return ot.needFile;
          d.receipt = { fileId: input.file.id, fileType: input.file.type, uniqueId: input.file.uniqueId };
          return undefined;
        },
      },
    ],
    finish: async (ctx, d) => {
      try {
        const topUp = await deps.topups.addReceipt(d.topUpId, d.clientId, d.receipt!);
        await ctx.reply(b.receiptSent(topUp.id), html);
        await deps.notifier.attachmentToAdmin(d.receipt!, `Чек по пополнению #${topUp.id}`);
        const dups = await findDuplicateReceipts(deps.db, d.receipt!.uniqueId, {
          topUpId: topUp.id,
          clientId: topUp.clientId,
        });
        await notifyAdminTopUp(
          deps,
          topUp,
          b.adminTopUpReceipt(topUp.id) + (dups.length ? `\n\n${ot.duplicateReceipt(dups)}` : ''),
        );
      } catch (e) {
        if (e instanceof TopUpNotPendingError) return void (await ctx.reply(b.receiptNotPending));
        throw e;
      }
    },
  };
}
