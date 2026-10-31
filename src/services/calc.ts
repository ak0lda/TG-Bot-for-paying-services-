import { computeQuote, formatRate } from '../domain/pricing.js';
import type { RatesProvider } from './rates.js';
import type { SettingsService } from './settings-service.js';

export interface Estimate {
  totalMinor: bigint;
  rate: string;
  source: 'CBR' | 'MANUAL';
}

/** Ориентировочная стоимость в рублях по текущим настройкам и курсу. Ничего не сохраняет; итог заявки фиксируется при расчёте админом. */
export async function estimate(
  deps: { rates: RatesProvider; settings: Pick<SettingsService, 'getAll'> },
  amountMinor: bigint,
  currency: string,
): Promise<Estimate> {
  const rate = await deps.rates.getRate(currency);
  const s = await deps.settings.getAll();
  const q = computeQuote({
    amountMinor,
    rateScaled: rate.scaled,
    fxBufferBp: s.fxBufferBp,
    markupBp: s.markupBp,
    fixedFeeMinor: BigInt(s.fixedFeeMinor),
  });
  return { totalMinor: q.totalMinor, rate: formatRate(rate.scaled), source: rate.source };
}
