export type Role = 'ADMIN' | 'CLIENT';
export type ClientAction = 'confirm' | 'pay' | 'cancel' | 'requote' | 'new_link' | 'renew';
export type AdminAction = 'quote' | 'confirm_payment' | 'payment_not_found' | 'link_invalid' | 'complete' | 'reject' | 'send_requisites';

/** Деньги приходят строками в минимальных единицах (копейки/центы). */
export interface Order {
  id: number;
  version: number;
  type: 'PAYMENT_LINK' | 'GIFT_CARD' | 'TOP_UP' | 'OTHER';
  typeLabel: string;
  status: string;
  statusLabel: string;
  service: string;
  description: string | null;
  comment: string | null;
  url: string | null;
  urlDomain: string | null;
  trusted: boolean | null;
  giftRegion: string | null;
  amountMinor: string | null;
  currency: string | null;
  isSubscription: boolean;
  periodKind: 'MONTH' | 'YEAR' | 'CUSTOM' | null;
  periodDays: number | null;
  nextChargeAt: string | null;
  renewedFromId: number | null;
  payMode: 'PREPAY' | 'BALANCE' | 'PAY_LATER';
  payModeLabel: string;
  totalMinor: string | null;
  reservedMinor: string | null;
  dueMinor: string | null;
  rate: string | null;
  rateSource: string | null;
  quoteExpiresAt: string | null;
  diffMinor: string | null;
  rejectReason: string | null;
  createdAt: string;
  actions: Array<ClientAction | AdminAction>;
  /** Реквизиты присылает админ в чат (в БД не хранятся). awaitingRequisites — ещё не прислал. */
  payment: { method: string | null; requiresReceipt: boolean; dueMinor: string | null; awaitingRequisites: boolean } | null;
  client: { id: number; name: string; username: string | null } | null;
}

export interface Method {
  id: number;
  title: string;
  /** У способа есть готовый текст — его можно отправить без ввода. */
  hasSavedText: boolean;
}

export interface Me {
  id: number;
  role: Role;
  name: string;
  balanceMinor: string;
  debtMinor: string;
  availableMinor: string;
  methods?: Method[];
  payModes?: Array<{ mode: Order['payMode']; label: string }>;
  cards?: Array<{ id: number; label: string; currency: string }>;
  staleLinkHours?: number;
}

export interface LedgerRow {
  id: number;
  type: string;
  label: string;
  amountMinor: string;
  orderId: number | null;
  comment: string | null;
  createdAt: string;
}

export interface Balance {
  balanceMinor: string;
  debtMinor: string;
  pendingTopUps: number;
  entries: LedgerRow[];
  topUpHint: string;
}

export interface StatRow {
  label: string;
  count: number;
  turnoverMinor: string;
}

export interface Stats {
  label: string;
  created: Record<string, number>;
  count: number;
  turnoverMinor: string;
  costMinor: string;
  profitMinor: string;
  topUpMinor: string;
  repaidMinor: string;
  byClient: StatRow[];
  byService: StatRow[];
  byCard: Array<{ label: string; currency: string; count: number; chargeMinor: string; rubMinor: string }>;
}
