import type { Balance, Me, Order, Stats } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let initData = '';
export const setInitData = (raw: string): void => {
  initData = raw;
};

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `tma ${initData}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* пустой или не JSON-ответ */
  }
  if (!res.ok) {
    throw new ApiError(res.status, String(json.error ?? 'error'), String(json.message ?? 'Ошибка запроса'), json);
  }
  return json as T;
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b: unknown = {}) => request<T>('POST', p, b);

type OrderRes = { order: Order };
const act = (prefix: string) => (id: number, action: string, body: unknown) => post<OrderRes>(`${prefix}/orders/${id}/${action}`, body);

export const api = {
  me: () => get<Me>('/me'),
  orders: () => get<{ orders: Order[] }>('/orders'),
  order: (id: number) => get<OrderRes>(`/orders/${id}`),
  createOrder: (body: unknown) => post<OrderRes & { untrustedDomain: boolean }>('/orders', body),
  client: act(''),
  balance: () => get<Balance>('/balance'),

  adminOrders: () => get<{ orders: Order[] }>('/admin/orders'),
  adminOrder: (id: number) => get<OrderRes>(`/admin/orders/${id}`),
  admin: act('/admin'),
  adminComplete: (id: number, body: unknown) =>
    post<OrderRes & { settlement: { actualRubMinor: string; baseCostMinor: string; diffMinor: string } }>(`/admin/orders/${id}/complete`, body),
  adminRate: (cur: string) => get<{ currency: string; rate: string; source: string }>(`/admin/rate/${cur}`),
  stats: (period: string) => get<Stats>(`/admin/stats?period=${encodeURIComponent(period)}`),
};
