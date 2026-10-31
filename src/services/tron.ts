import { z } from 'zod';

export interface TronTransfer {
  txid: string;
  amountMicro: bigint;
  from: string;
  at: Date;
}

const transferSchema = z.object({
  transaction_id: z.string().regex(/^[0-9a-fA-F]{64}$/),
  token_info: z.object({ address: z.string() }),
  block_timestamp: z.number().int().positive(),
  from: z.string(),
  to: z.string(),
  type: z.string().optional(),
  value: z.string().regex(/^\d{1,30}$/),
});

const responseSchema = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ fingerprint: z.string().optional() }).passthrough().optional(),
});

export class TronApiError extends Error {}

export interface TronClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  fetchFn?: typeof fetch;
}

/**
 * Чтение входящих USDT-переводов через TronGrid (только подтверждённые, только на наш адрес).
 * Ключей кошелька у сервера нет — только публичный адрес, так что утечка из бота не даёт доступа к деньгам.
 */
export class TronGridClient {
  constructor(private readonly opts: TronClientOptions) {}

  async incomingUsdt(address: string, contract: string, sinceMs: number): Promise<TronTransfer[]> {
    const f = this.opts.fetchFn ?? fetch;
    const out: TronTransfer[] = [];
    let fingerprint: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`/v1/accounts/${address}/transactions/trc20`, this.opts.baseUrl);
      url.searchParams.set('only_confirmed', 'true');
      url.searchParams.set('only_to', 'true');
      url.searchParams.set('min_timestamp', String(Math.max(0, Math.floor(sinceMs))));
      url.searchParams.set('order_by', 'block_timestamp,asc');
      url.searchParams.set('limit', '200');
      url.searchParams.set('contract_address', contract);
      if (fingerprint) url.searchParams.set('fingerprint', fingerprint);
      const res = await f(url, {
        headers: { accept: 'application/json', ...(this.opts.apiKey ? { 'TRON-PRO-API-KEY': this.opts.apiKey } : {}) },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new TronApiError(`trongrid http ${res.status}`);
      const parsed = responseSchema.safeParse(await res.json());
      if (!parsed.success) throw new TronApiError('trongrid: unexpected response');
      for (const raw of parsed.data.data) {
        const t = transferSchema.safeParse(raw);
        if (!t.success) continue; // чужой/непонятный формат записи — пропускаем, а не падаем
        const v = t.data;
        if (v.to !== address || v.token_info.address !== contract) continue;
        if (v.type && v.type !== 'Transfer') continue;
        out.push({
          txid: v.transaction_id.toLowerCase(),
          amountMicro: BigInt(v.value),
          from: v.from,
          at: new Date(v.block_timestamp),
        });
      }
      fingerprint = parsed.data.meta?.fingerprint;
      if (!fingerprint) break;
    }
    return out;
  }
}
