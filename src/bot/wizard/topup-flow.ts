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
}

export async function startTopUp(ctx: BotContext, deps: Deps, opts: { repayDebt?: boolean } = {}): Promise<void> {
  const clientId = ctx.appUser!.id;
  const debt = debtOf(await balanceOf(deps.db, clientId));
  deps.wizards.cancel(ctx.from!.id);
  await deps.wizards.start(ctx, topUpWizard(deps), {
    clientId,
    debt,
    ...(opts.repayDebt && debt > 0n ? { amountMinor: debt } : {}),
  } satisfies TopUpData);
}

function topUpWizard(deps: Deps): WizardDef<TopUpData> {
  return {
    name: 'topup',
    steps: [
      {
        key: 'amount',
        skip: (d) => d.amountMinor !== undefined,
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
