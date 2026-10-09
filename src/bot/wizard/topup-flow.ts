import { InlineKeyboard } from 'grammy';
import type { PaymentMethod } from '@prisma/client';
import type { BotContext, Deps } from '../context.js';
import type { WizardDef } from './engine.js';
import { debtOf } from '../../domain/ledger.js';
import { MoneyParseError, parseDecimalToMinor } from '../../domain/money.js';
import { balanceOf } from '../../services/ledger-service.js';
import type { Attached } from '../../services/order-service.js';
import { b } from '../../texts/balance.js';
import { o as ot } from '../../texts/orders.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const MIN_MINOR = 100n; // 1 ₽
const MAX_MINOR = 1_000_000_000n; // 10 000 000 ₽

interface TopUpData {
  clientId: number;
  debt: bigint;
  amountMinor?: bigint;
  methods: PaymentMethod[];
  methodId: number | null;
  receipt?: Attached;
}

export async function startTopUp(ctx: BotContext, deps: Deps, opts: { repayDebt?: boolean } = {}): Promise<void> {
  const clientId = ctx.appUser!.id;
  const methods = await deps.catalog.listMethods(true);
  if (methods.length === 0) return void (await ctx.reply(b.noMethods));
  const debt = debtOf(await balanceOf(deps.db, clientId));
  const data: TopUpData = {
    clientId,
    debt,
    methods,
    methodId: methods.length === 1 ? methods[0]!.id : null,
    ...(opts.repayDebt && debt > 0n ? { amountMinor: debt } : {}),
  };
  deps.wizards.cancel(ctx.from!.id);
  await deps.wizards.start(ctx, topUpWizard(deps), data);
}

const methodOf = (d: TopUpData): PaymentMethod => d.methods.find((m) => m.id === d.methodId)!;

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
      {
        key: 'method',
        skip: (d) => d.methodId !== null,
        prompt: (d) => ({ text: b.chooseMethod, buttons: d.methods.map((m) => [{ label: m.title, value: String(m.id) }]) }),
        handle: async (input, d) => {
          const m = d.methods.find((x) => String(x.id) === input.button);
          if (!m) return ot.useButtons;
          d.methodId = m.id;
          return undefined;
        },
      },
      {
        key: 'receipt',
        skip: (d) => !methodOf(d).requiresReceipt,
        prompt: (d) => ({ text: `${b.transferInstructions(d.amountMinor!, methodOf(d))}\n\n${b.sendReceipt}` }),
        handle: async (input, d) => {
          if (!input.file) return ot.needFile;
          d.receipt = { fileId: input.file.id, fileType: input.file.type };
          return undefined;
        },
      },
    ],
    finish: async (ctx, d) => {
      const method = methodOf(d);
      const topUp = await deps.topups.create(d.clientId, d.amountMinor!, method.id, d.receipt);
      deps.log.info({ topUpId: topUp.id }, 'top-up requested');
      if (d.receipt) {
        await ctx.reply(b.topUpSent(topUp.id), html);
      } else {
        await ctx.reply(b.topUpSentNoReceipt(topUp.id, b.transferInstructions(d.amountMinor!, method)), html);
      }
      if (d.receipt) await deps.notifier.attachmentToAdmin(d.receipt, `Чек по пополнению #${topUp.id}`);
      const kb = new InlineKeyboard().text(b.confirmTopUp, `t:${topUp.id}:ok`).text(b.rejectTopUp, `t:${topUp.id}:no`);
      await deps.notifier.toAdmin(
        b.adminTopUp({ id: topUp.id, client: topUp.client, amount: d.amountMinor!, method: method.title, receipt: !!d.receipt, debt: d.debt }),
        kb,
      );
    },
  };
}
