import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../context.js';
import { WIZARD_CANCEL, wizardCb } from '../callbacks.js';
import { o as ot } from '../../texts/orders.js';

export interface WizardInput {
  text?: string;
  button?: string;
  file?: { id: string; type: 'photo' | 'document' };
}

export interface Prompt {
  text: string;
  /** Строки кнопок: [{label, value}]. Кнопка «Отмена» добавляется автоматически. */
  buttons?: Array<Array<{ label: string; value: string }>>;
}

export interface Step<D> {
  key: string;
  skip?: (d: D) => boolean;
  prompt: (d: D) => Prompt | Promise<Prompt>;
  /** Возвращает текст ошибки (шаг повторяется) или undefined (шаг принят). */
  handle: (input: WizardInput, d: D, ctx: BotContext) => Promise<string | undefined>;
}

export interface WizardDef<D> {
  name: string;
  steps: Step<D>[];
  finish: (ctx: BotContext, d: D) => Promise<void>;
}

interface Active {
  def: WizardDef<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  stepIndex: number;
  touchedAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

/** Лёгкий движок пошаговых диалогов. Состояние в памяти (черновик теряется при рестарте — это нормально). */
export class WizardManager {
  private active = new Map<number, Active>();

  constructor(private readonly now: () => number = Date.now) {}

  has(telegramId: number): boolean {
    return this.live(telegramId) !== undefined;
  }

  cancel(telegramId: number): boolean {
    return this.active.delete(telegramId);
  }

  async start<D>(ctx: BotContext, def: WizardDef<D>, data: D): Promise<void> {
    const a: Active = { def, data, stepIndex: -1, touchedAt: this.now() };
    this.active.set(ctx.from!.id, a);
    await this.advance(ctx, a, 0);
  }

  /** true — сообщение поглощено диалогом. */
  async onMessage(ctx: BotContext): Promise<boolean> {
    const a = this.live(ctx.from!.id);
    if (!a) return false;
    const msg = ctx.message;
    if (!msg) return false;
    const input: WizardInput = {};
    if (msg.text) input.text = msg.text;
    if (msg.photo?.length) input.file = { id: msg.photo[msg.photo.length - 1]!.file_id, type: 'photo' };
    else if (msg.document) input.file = { id: msg.document.file_id, type: 'document' };
    if (!input.text && !input.file) return false;
    await this.handle(ctx, a, input);
    return true;
  }

  async onCallback(ctx: BotContext): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';
    const a = this.live(ctx.from!.id);
    if (data === WIZARD_CANCEL) {
      this.cancel(ctx.from!.id);
      await ctx.answerCallbackQuery({ text: ot.wizardCanceled });
      await this.clearKeyboard(ctx);
      return;
    }
    if (!a) {
      await ctx.answerCallbackQuery({ text: ot.wizardExpired });
      await this.clearKeyboard(ctx);
      return;
    }
    const m = /^w:([a-zA-Z]+):(.+)$/.exec(data);
    const step = a.def.steps[a.stepIndex];
    if (!m || !step || m[1] !== step.key) {
      await ctx.answerCallbackQuery({ text: ot.buttonStale });
      return;
    }
    await ctx.answerCallbackQuery();
    await this.clearKeyboard(ctx);
    await this.handle(ctx, a, { button: m[2]! });
  }

  private live(telegramId: number): Active | undefined {
    const a = this.active.get(telegramId);
    if (!a) return undefined;
    if (this.now() - a.touchedAt > TTL_MS) {
      this.active.delete(telegramId);
      return undefined;
    }
    return a;
  }

  private async handle(ctx: BotContext, a: Active, input: WizardInput): Promise<void> {
    a.touchedAt = this.now();
    const step = a.def.steps[a.stepIndex]!;
    const error = await step.handle(input, a.data, ctx);
    if (error) {
      await ctx.reply(error, html);
      return;
    }
    await this.advance(ctx, a, a.stepIndex + 1);
  }

  private async advance(ctx: BotContext, a: Active, from: number): Promise<void> {
    let i = from;
    while (i < a.def.steps.length && a.def.steps[i]!.skip?.(a.data)) i++;
    if (i >= a.def.steps.length) {
      this.active.delete(ctx.from!.id);
      await a.def.finish(ctx, a.data);
      return;
    }
    a.stepIndex = i;
    const step = a.def.steps[i]!;
    const prompt = await step.prompt(a.data);
    const kb = new InlineKeyboard();
    for (const row of prompt.buttons ?? []) {
      for (const b of row) kb.text(b.label, wizardCb(step.key, b.value));
      kb.row();
    }
    kb.text(ot.cancelBtn, WIZARD_CANCEL);
    await ctx.reply(prompt.text, { ...html, reply_markup: kb });
  }

  private async clearKeyboard(ctx: BotContext): Promise<void> {
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }
}

/** Удаляет сообщение пользователя с чувствительными данными (если Telegram позволяет). */
export async function tryDelete(ctx: BotContext): Promise<void> {
  await ctx.deleteMessage().catch(() => undefined);
}
