import type { BotContext } from '../context.js';
import { detectSecret } from '../../domain/secret-detector.js';
import { validateLink } from '../../domain/link-validator.js';
import type { Deps } from '../context.js';
import { o as ot } from '../../texts/orders.js';
import { tryDelete, type WizardInput } from './engine.js';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Свободный текст: длина + защита от паролей/карт/кодов. Чувствительное сообщение удаляется и не сохраняется. */
export async function freeText(
  input: WizardInput,
  ctx: BotContext,
  min: number,
  max: number,
  opts: { checkSecrets?: boolean } = {},
): Promise<Result<string>> {
  const text = input.text?.trim();
  if (!text) return { ok: false, error: ot.needText };
  if (opts.checkSecrets !== false && detectSecret(text)) {
    await tryDelete(ctx);
    return { ok: false, error: ot.secretWarning };
  }
  if (text.length < min || text.length > max) return { ok: false, error: ot.badText(min, max) };
  return { ok: true, value: text };
}

export async function linkInput(
  input: WizardInput,
  deps: Pick<Deps, 'domains'>,
): Promise<Result<{ url: string; domain: string; trusted: boolean }>> {
  if (!input.text) return { ok: false, error: ot.link.invalid };
  const res = validateLink(input.text, await deps.domains.list());
  if (!res.ok) return { ok: false, error: ot.link[res.error] };
  return { ok: true, value: { url: res.url, domain: res.domain, trusted: res.trusted } };
}
