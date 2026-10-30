import { useState } from 'react';
import { api, ApiError } from './api';
import { ageOf, formatDate, money, periodText, rub, signedRub } from './format';
import { backToChat } from './tg';
import type { Me, Order } from './types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Row,
  Segmented,
  Spinner,
  statusTone,
  useAction,
  useLoad,
  useToast,
} from './ui';

// ── Мои заявки ───────────────────────────────────────────────
export function OrderList({ open }: { open: (id: number) => void }) {
  const { data, error, loading, reload } = useLoad(() => api.orders(), []);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox text={error} onRetry={reload} />;
  const orders = data?.orders ?? [];
  return (
    <>
      <h1>Мои заявки</h1>
      {orders.length === 0 && (
        <Empty>
          Заявок пока нет.
          <br />
          Создайте первую на вкладке «Новая».
        </Empty>
      )}
      {orders.map((o) => (
        <Card key={o.id} onClick={() => open(o.id)}>
          <div className="title">
            <span>
              #{o.id} · {o.service}
            </span>
            <Badge tone={statusTone(o.status)}>{o.statusLabel}</Badge>
          </div>
          <div className="sub">
            {money(o.amountMinor, o.currency)}
            {o.totalMinor ? ` → ${rub(o.totalMinor)}` : ''} · {ageOf(o.createdAt)} назад
          </div>
        </Card>
      ))}
    </>
  );
}

// ── Карточка заявки (клиент) ─────────────────────────────────
type Panel = null | 'cancel' | 'new_link' | 'renew' | 'receipt';

export function OrderDetail({ id, me, onChanged }: { id: number; me: Me; onChanged: () => void }) {
  const { data, error, loading, reload, setData } = useLoad(() => api.order(id), [id]);
  const { busy, run } = useAction(reload);
  const toast = useToast();
  const [panel, setPanel] = useState<Panel>(null);
  const [url, setUrl] = useState('');
  const [payMode, setPayMode] = useState<string>('PREPAY');

  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox text={error ?? 'Заявка не найдена'} onRetry={reload} />;
  const o = data.order;

  const apply = (order: Order) => {
    setData({ order });
    setPanel(null);
    onChanged();
  };
  const act = (action: string, body: Record<string, unknown>, okText: string) =>
    run(() => api.client(o.id, action, { version: o.version, ...body }), okText).then((r) => r && apply(r.order));

  return (
    <>
      <h1>Заявка #{o.id}</h1>
      <Card>
        <div className="title">
          <span>{o.service}</span>
          <Badge tone={statusTone(o.status)}>{o.statusLabel}</Badge>
        </div>
        <div className="sub">{o.typeLabel}</div>
        <div style={{ height: 8 }} />
        {o.description && <Row k="Описание">{o.description}</Row>}
        {o.giftRegion && <Row k="Регион">{o.giftRegion}</Row>}
        <Row k="Сумма на сайте">
          {money(o.amountMinor, o.currency)}
          {o.isSubscription ? ` · подписка (${periodText(o.periodKind, o.periodDays)})` : ''}
        </Row>
        {o.totalMinor && (
          <Row k="К оплате">
            <b>{rub(o.totalMinor)}</b>
          </Row>
        )}
        {o.rate && (
          <Row k="Курс">
            {o.rate} ₽ ({o.rateSource === 'MANUAL' ? 'ручной' : 'ЦБ'})
          </Row>
        )}
        <Row k="Способ оплаты">{o.payModeLabel}</Row>
        {BigInt(o.reservedMinor ?? '0') > 0n && <Row k="Зарезервировано с баланса">{rub(o.reservedMinor)}</Row>}
        {o.quoteExpiresAt && ['QUOTED', 'AWAITING_PAYMENT'].includes(o.status) && (
          <Row k="Расчёт действует до">{formatDate(o.quoteExpiresAt)}</Row>
        )}
        {o.nextChargeAt && <Row k="Следующее списание">{formatDate(o.nextChargeAt, false)}</Row>}
        {o.urlDomain && <Row k="Сайт оплаты">{o.urlDomain}</Row>}
        {o.diffMinor && o.diffMinor !== '0' && <Row k="Разница по факту">{signedRub(o.diffMinor)}</Row>}
        {o.rejectReason && <Row k="Причина отказа">{o.rejectReason}</Row>}
        <Row k="Создана">{formatDate(o.createdAt)}</Row>
      </Card>

      {o.payment?.awaitingRequisites && (
        <div className="warnbox">
          ⏳ <b>Ждём реквизиты</b> — админ пришлёт их сообщением в чат с ботом. Не переводите деньги, пока не получите
          реквизиты.
          <div className="sub">
            К оплате: <b>{rub(o.payment.dueMinor)}</b>
          </div>
        </div>
      )}
      {o.payment && !o.payment.awaitingRequisites && (
        <div className="warnbox">
          <b>Переведите {rub(o.payment.dueMinor)}</b> — {o.payment.method}
          <div className="sub">
            Реквизиты — в сообщении бота в чате. После перевода нажмите «Я оплатил».
            {o.payment.requiresReceipt ? ' Чек отправляется в чате с ботом.' : ''}
          </div>
        </div>
      )}
      {o.status === 'LINK_INVALID' && (
        <div className="errbox">Ссылка не работает. Пришлите новую — ваша оплата сохранена.</div>
      )}

      {panel === 'receipt' && (
        <div className="okbox">
          Для этого способа нужен чек. Откройте чат с ботом и нажмите «Я оплатил» в сообщении по заявке #{o.id} — там
          можно приложить скриншот.
          <Button onClick={backToChat}>Вернуться в чат</Button>
        </div>
      )}

      {(panel === 'new_link' || panel === 'renew') && (
        <Card>
          <Field label="Свежая https-ссылка на оплату">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              inputMode="url"
              placeholder="https://…"
              autoComplete="off"
            />
          </Field>
          {panel === 'renew' && (me.payModes?.length ?? 0) > 1 && (
            <Field label="Способ оплаты">
              <select value={payMode} onChange={(e) => setPayMode(e.target.value)}>
                {me.payModes?.map((m) => (
                  <option key={m.mode} value={m.mode}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="sub">Ссылка может истечь — переводите оплату сразу после расчёта.</div>
        </Card>
      )}
      {panel === 'cancel' && <div className="errbox">Отменить заявку #{o.id}?</div>}

      {o.actions.includes('confirm') && (
        <Button busy={busy} onClick={() => void act('confirm', {}, 'Расчёт подтверждён')}>
          Подтвердить расчёт
        </Button>
      )}
      {o.actions.includes('pay') && (
        <Button
          busy={busy}
          onClick={() =>
            o.payment?.requiresReceipt ? setPanel('receipt') : void act('paid', {}, 'Отправлено на проверку')
          }
        >
          Я оплатил
        </Button>
      )}
      {o.actions.includes('requote') && (
        <Button busy={busy} onClick={() => void act('requote', {}, 'Расчёт обновлён')}>
          Пересчитать
        </Button>
      )}
      {o.actions.includes('new_link') && (
        <Button
          busy={busy}
          onClick={() =>
            panel === 'new_link' ? void act('new-link', { url }, 'Ссылка отправлена') : setPanel('new_link')
          }
        >
          Отправить новую ссылку
        </Button>
      )}
      {o.actions.includes('renew') && (
        <Button
          busy={busy}
          onClick={() => {
            if (panel !== 'renew') return setPanel('renew');
            void run(() => api.client(o.id, 'renew', { url: url || undefined, payMode }), 'Продление оформлено').then(
              (r) => {
                if (r) {
                  onChanged();
                  toast(`Создана заявка #${r.order.id}`);
                }
              },
            );
          }}
        >
          Продлить подписку
        </Button>
      )}
      {o.actions.includes('cancel') && (
        <Button
          kind="danger"
          busy={busy}
          onClick={() => (panel === 'cancel' ? void act('cancel', {}, 'Заявка отменена') : setPanel('cancel'))}
        >
          {panel === 'cancel' ? 'Да, отменить' : 'Отменить заявку'}
        </Button>
      )}
      {panel && panel !== 'receipt' && (
        <Button kind="secondary" onClick={() => setPanel(null)}>
          Назад
        </Button>
      )}
    </>
  );
}

// ── Новая заявка ─────────────────────────────────────────────
type OrderType = Order['type'];
const TYPES: Array<{ value: OrderType; label: string }> = [
  { value: 'PAYMENT_LINK', label: 'Ссылка на оплату' },
  { value: 'GIFT_CARD', label: 'Подарочная карта' },
  { value: 'TOP_UP', label: 'Пополнение' },
  { value: 'OTHER', label: 'Другое' },
];
const CURRENCIES = ['USD', 'EUR', 'GBP'];

export function NewOrder({ me, created }: { me: Me; created: (id: number) => void }) {
  const toast = useToast();
  const [type, setType] = useState<OrderType>('PAYMENT_LINK');
  const [f, setF] = useState({
    url: '',
    service: '',
    region: '',
    description: '',
    amount: '',
    currency: 'USD',
    other: '',
    comment: '',
    days: '',
  });
  const [period, setPeriod] = useState<'ONE' | 'MONTH' | 'YEAR' | 'CUSTOM'>('ONE');
  const [payMode, setPayMode] = useState<string>('PREPAY');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const gift = type === 'GIFT_CARD';
  const subscribable = type === 'PAYMENT_LINK' || type === 'OTHER';
  const currency = f.currency === 'OTHER' ? f.other.trim().toUpperCase() : f.currency;

  const submit = async () => {
    setErrors({});
    const body = {
      type,
      ...(gift ? {} : { url: f.url.trim() || undefined, description: f.description.trim() || undefined }),
      service: f.service.trim(),
      ...(gift ? { region: f.region.trim() || undefined } : {}),
      amount: f.amount.trim(),
      currency,
      period: subscribable ? period : 'ONE',
      ...(subscribable && period === 'CUSTOM' ? { periodDays: Number(f.days) || undefined } : {}),
      comment: f.comment.trim() || undefined,
      payMode,
    };
    const res = await run(
      () => api.createOrder(body),
      undefined,
      (e) => {
        // Подсвечиваем поле, на которое указал сервер (ссылка, сумма, валюта…).
        if (e instanceof ApiError && typeof e.extra.field === 'string') setErrors({ [e.extra.field]: e.message });
      },
    );
    if (!res) return;
    toast(
      res.untrustedDomain ? 'Заявка создана. Домен не из списка доверенных — админ проверит ссылку.' : 'Заявка создана',
    );
    created(res.order.id);
  };

  return (
    <>
      <h1>Новая заявка</h1>
      <Field label="Что оплатить">
        <Segmented value={type} options={TYPES} onChange={setType} />
      </Field>

      {!gift && (
        <Field
          label={type === 'OTHER' ? 'Ссылка на оплату (необязательно)' : 'Ссылка на оплату (https)'}
          error={errors.url}
        >
          <input value={f.url} onChange={set('url')} inputMode="url" placeholder="https://…" autoComplete="off" />
        </Field>
      )}
      <Field label={gift ? 'Магазин (App Store, Steam, Amazon…)' : 'Сервис'} error={errors.service}>
        <input value={f.service} onChange={set('service')} placeholder={gift ? 'Steam' : 'Netflix'} />
      </Field>
      {gift && (
        <Field label="Регион карты" error={errors.region}>
          <input value={f.region} onChange={set('region')} placeholder="US, TR, EU…" />
        </Field>
      )}
      {!gift && (
        <Field
          label={
            type === 'OTHER' ? 'Что нужно оплатить' : type === 'TOP_UP' ? 'Что пополняем' : 'Тариф / что оплачиваем'
          }
          error={errors.description}
        >
          <textarea value={f.description} onChange={set('description')} />
        </Field>
      )}

      <Field label={gift ? 'Номинал' : 'Сумма на странице оплаты'} error={errors.amount}>
        <input value={f.amount} onChange={set('amount')} inputMode="decimal" placeholder="15,99" />
      </Field>
      <Field label="Валюта" error={errors.currency}>
        <select value={f.currency} onChange={set('currency')}>
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="OTHER">Другая…</option>
        </select>
        {f.currency === 'OTHER' && (
          <input style={{ marginTop: 6 }} value={f.other} onChange={set('other')} maxLength={3} placeholder="CHF" />
        )}
      </Field>

      {subscribable && (
        <Field label="Периодичность">
          <Segmented
            value={period}
            options={[
              { value: 'ONE', label: 'Разовая' },
              { value: 'MONTH', label: 'Месяц' },
              { value: 'YEAR', label: 'Год' },
              { value: 'CUSTOM', label: 'Свой период' },
            ]}
            onChange={setPeriod}
          />
          {period === 'CUSTOM' && (
            <input
              style={{ marginTop: 6 }}
              value={f.days}
              onChange={set('days')}
              inputMode="numeric"
              placeholder="Дней между списаниями"
            />
          )}
        </Field>
      )}

      {(me.payModes?.length ?? 0) > 1 && (
        <Field label="Как будете платить" error={errors.payMode}>
          <select value={payMode} onChange={(e) => setPayMode(e.target.value)}>
            {me.payModes?.map((m) => (
              <option key={m.mode} value={m.mode}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Комментарий (необязательно)" error={errors.comment}>
        <textarea value={f.comment} onChange={set('comment')} />
      </Field>
      <div className="sub">Не указывайте пароли и данные банковских карт — такие заявки не принимаются.</div>
      <Button busy={busy} onClick={() => void submit()}>
        Отправить заявку
      </Button>
    </>
  );
}

// ── Баланс ───────────────────────────────────────────────────
export function BalanceScreen() {
  const { data, error, loading, reload } = useLoad(() => api.balance(), []);
  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox text={error ?? 'Нет данных'} onRetry={reload} />;
  const debt = BigInt(data.debtMinor) > 0n;
  return (
    <>
      <h1>Баланс</h1>
      <Card>
        <div className="sub">{debt ? 'Долг' : 'На балансе'}</div>
        <div className={`big${debt ? ' debt' : ''}`}>{debt ? rub(data.debtMinor) : rub(data.balanceMinor)}</div>
        {data.pendingTopUps > 0 && <div className="sub">Пополнений на проверке: {data.pendingTopUps}</div>}
      </Card>
      <div className="okbox">
        {data.topUpHint}
        <Button onClick={backToChat}>Открыть чат</Button>
      </div>
      <h2>Операции</h2>
      {data.entries.length === 0 && <Empty>Операций пока нет.</Empty>}
      <Card>
        {data.entries.map((e) => (
          <Row key={e.id} k={`${formatDate(e.createdAt)} · ${e.label}${e.orderId ? ` #${e.orderId}` : ''}`}>
            <b>{signedRub(e.amountMinor)}</b>
          </Row>
        ))}
      </Card>
    </>
  );
}
