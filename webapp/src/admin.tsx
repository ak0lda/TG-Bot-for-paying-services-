import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { ageOf, money, periodText, rub, signedRub } from './format';
import { openExternal } from './tg';
import type { AdminAction, Me, Order, Stats } from './types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Row,
  Spinner,
  statusTone,
  useAction,
  useLoad,
  useToast,
} from './ui';

// ── Очередь заявок ───────────────────────────────────────────
export function Queue({ open }: { open: (id: number) => void }) {
  const { data, error, loading, reload } = useLoad(() => api.adminOrders(), []);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox text={error} onRetry={reload} />;
  const orders = data?.orders ?? [];
  return (
    <>
      <h1>Очередь</h1>
      {orders.length === 0 && <Empty>Открытых заявок нет.</Empty>}
      {orders.map((o) => (
        <Card key={o.id} onClick={() => open(o.id)}>
          <div className="title">
            <span>
              #{o.id} · {o.service}
            </span>
            <Badge tone={statusTone(o.status)}>{o.statusLabel}</Badge>
          </div>
          <div className="sub">
            {o.client?.name} · {money(o.amountMinor, o.currency)}
            {o.totalMinor ? ` → ${rub(o.totalMinor)}` : ''} · {ageOf(o.createdAt)}
            {o.urlDomain ? (o.trusted ? ' · ✅' : ' · ⚠️ неизв. домен') : ''}
          </div>
        </Card>
      ))}
      <button className="btn secondary" onClick={reload}>
        Обновить
      </button>
    </>
  );
}

// ── Заявка (админ) ───────────────────────────────────────────
type Panel = null | 'reject' | 'complete';

export function AdminOrder({ id, me, onChanged }: { id: number; me: Me; onChanged: () => void }) {
  const { data, error, loading, reload, setData } = useLoad(() => api.adminOrder(id), [id]);
  const { busy, run } = useAction(reload);
  const toast = useToast();
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState('');
  const cards = me.cards ?? [];
  const [form, setForm] = useState({ cardId: cards[0]?.id ?? 0, actual: '', rate: '', giftCode: '' });
  // Подсказка с курсом карты: помним, для какой валюты она получена, чтобы не сбрасывать состояние внутри эффекта.
  const [rateHint, setRateHint] = useState<{ cur: string; text: string } | null>(null);
  const [mountedAt] = useState(() => Date.now());
  // Предупреждения по курсу перед расчётом (сервер ответил 409 rate_warning): админ решает, считать ли.
  const [rateWarn, setRateWarn] = useState<string[] | null>(null);
  const methods = me.methods ?? [];
  const [req, setReq] = useState<{ methodId: number; text: string }>({ methodId: methods[0]?.id ?? 0, text: '' });

  const card = cards.find((c) => c.id === form.cardId);
  const cardCurrency = card?.currency;
  useEffect(() => {
    if (panel !== 'complete' || !cardCurrency || cardCurrency === 'RUB') return;
    let alive = true;
    api.adminRate(cardCurrency).then(
      (r) =>
        alive && setRateHint({ cur: cardCurrency, text: `${r.rate} (${r.source === 'MANUAL' ? 'ручной' : 'ЦБ'})` }),
      () => alive && setRateHint({ cur: cardCurrency, text: 'нет данных — введите курс' }),
    );
    return () => {
      alive = false;
    };
  }, [panel, cardCurrency]);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox text={error ?? 'Заявка не найдена'} onRetry={reload} />;
  const o = data.order;
  const has = (a: AdminAction) => (o.actions as string[]).includes(a);
  const apply = (order: Order) => {
    setData({ order });
    setPanel(null);
    onChanged();
  };
  const simple = (path: string, okText: string, body: Record<string, unknown> = {}) =>
    run(() => api.admin(o.id, path, { version: o.version, ...body }), okText).then((r) => r && apply(r.order));

  const sendRequisites = async () => {
    const res = await run(
      () =>
        api.admin(o.id, 'requisites', {
          version: o.version,
          methodId: req.methodId,
          ...(req.text.trim() ? { text: req.text.trim() } : {}),
        }),
      'Реквизиты отправлены клиенту',
    );
    if (!res) return;
    apply(res.order);
    setReq((r) => ({ ...r, text: '' }));
  };

  const quote = async (force: boolean) => {
    const res = await run(
      () => api.admin(o.id, 'quote', { version: o.version, ...(force ? { force: true } : {}) }),
      'Расчёт готов',
      (e) => {
        if (e instanceof ApiError && e.code === 'rate_warning') {
          setRateWarn(((e.extra.warnings ?? []) as Array<{ text: string }>).map((w) => w.text));
        }
      },
    );
    if (res) {
      setRateWarn(null);
      apply(res.order);
    }
  };

  const complete = async () => {
    const res = await run(() =>
      api.adminComplete(o.id, {
        version: o.version,
        cardId: form.cardId,
        actual: form.actual,
        ...(form.rate ? { rate: form.rate } : {}),
        ...(form.giftCode ? { giftCode: form.giftCode } : {}),
      }),
    );
    if (!res) return;
    apply(res.order);
    const diff = BigInt(res.settlement.diffMinor);
    toast(diff === 0n ? 'Выполнено' : `Выполнено. Разница: ${signedRub(res.settlement.diffMinor)}`);
  };

  const ageH = (mountedAt - new Date(o.createdAt).getTime()) / 3_600_000;
  return (
    <>
      <h1>Заявка #{o.id}</h1>
      {o.urlDomain &&
        (o.trusted ? (
          <div className="okbox">
            ✅ Доверенный домен: <b>{o.urlDomain}</b>
          </div>
        ) : (
          <div className="warnbox">
            ⚠️ <b>НЕИЗВЕСТНЫЙ ДОМЕН — проверь перед вводом карты:</b> {o.urlDomain}
          </div>
        ))}
      {o.linkRisks.length > 0 && (
        <div className="errbox">
          ⛔ <b>ПОДОЗРИТЕЛЬНАЯ ССЫЛКА</b>
          {o.linkRisks.map((r) => (
            <div key={r} style={{ marginTop: 4 }}>
              • {r}
            </div>
          ))}
        </div>
      )}
      {o.url && ageH > (me.staleLinkHours ?? 24) && !['DONE', 'CANCELED', 'REJECTED'].includes(o.status) && (
        <div className="warnbox">⏳ Заявке {ageOf(o.createdAt)} — ссылка может быть недействительна.</div>
      )}
      <Card>
        <div className="title">
          <span>{o.service}</span>
          <Badge tone={statusTone(o.status)}>{o.statusLabel}</Badge>
        </div>
        <div className="sub">{o.typeLabel}</div>
        <div style={{ height: 8 }} />
        <Row k="Клиент">
          #{o.client?.id} {o.client?.name}
          {o.client?.username ? ` @${o.client.username}` : ''}
        </Row>
        {o.description && <Row k="Описание">{o.description}</Row>}
        {o.giftRegion && <Row k="Регион">{o.giftRegion}</Row>}
        <Row k="Сумма">
          <b>{money(o.amountMinor, o.currency)}</b>
          {o.isSubscription ? ` · подписка (${periodText(o.periodKind, o.periodDays)})` : ''}
        </Row>
        {o.totalMinor && (
          <Row k="Клиенту к оплате">
            <b>{rub(o.totalMinor)}</b>
          </Row>
        )}
        {o.rate && (
          <Row k="Курс">
            {o.rate} ₽ ({o.rateSource === 'MANUAL' ? 'ручной' : 'ЦБ'})
          </Row>
        )}
        <Row k="Оплата клиента">{o.payModeLabel}</Row>
        {BigInt(o.reservedMinor ?? '0') > 0n && <Row k="С баланса">{rub(o.reservedMinor)}</Row>}
        {o.comment && <Row k="Комментарий">{o.comment}</Row>}
        {o.diffMinor && o.diffMinor !== '0' && <Row k="Разница по факту">{signedRub(o.diffMinor)}</Row>}
        {o.rejectReason && <Row k="Причина отказа">{o.rejectReason}</Row>}
        <Row k="Возраст">{ageOf(o.createdAt)}</Row>
      </Card>

      {has('send_requisites') && (
        <Card>
          <div className="title">
            <span>Реквизиты клиенту</span>
          </div>
          <div className="sub" style={{ marginBottom: 8 }}>
            {o.payment?.method
              ? `📤 Отправлено: ${o.payment.method}. Можно отправить ещё раз или выбрать другой способ.`
              : '⏳ Клиент ждёт реквизиты. Текст уйдёт ему в чат и в базе не сохраняется.'}{' '}
            К оплате: <b>{rub(o.payment?.dueMinor ?? o.totalMinor)}</b>
          </div>
          <Field label="Способ перевода">
            <select value={req.methodId} onChange={(e) => setReq({ ...req, methodId: Number(e.target.value) })}>
              {methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={
              methods.find((m) => m.id === req.methodId)?.hasSavedText
                ? 'Реквизиты (пусто — отправить готовый текст способа)'
                : 'Реквизиты'
            }
          >
            <textarea
              value={req.text}
              onChange={(e) => setReq({ ...req, text: e.target.value })}
              placeholder="Телефон, банк, получатель, сумма…"
              autoComplete="off"
            />
          </Field>
          <Button
            busy={busy}
            disabled={
              !req.methodId || (req.text.trim().length < 3 && !methods.find((m) => m.id === req.methodId)?.hasSavedText)
            }
            onClick={() => void sendRequisites()}
          >
            📤 Отправить реквизиты
          </Button>
        </Card>
      )}

      {o.status === 'IN_PROGRESS' && o.url && (
        <Button kind="secondary" onClick={() => openExternal(o.url!)}>
          🔗 Открыть ссылку
        </Button>
      )}

      {panel === 'reject' && (
        <Card>
          <Field label="Причина отклонения (увидит клиент)">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Card>
      )}
      {panel === 'complete' && (
        <Card>
          {cards.length === 0 && (
            <div className="errbox">Нет активных карт — добавьте в чате: /card_add Visa ··4417 USD</div>
          )}
          {o.type === 'GIFT_CARD' && (
            <Field label="Код подарочной карты (уйдёт клиенту)">
              <input
                value={form.giftCode}
                onChange={(e) => setForm({ ...form, giftCode: e.target.value })}
                autoComplete="off"
              />
            </Field>
          )}
          <Field label="Какой картой платил">
            <select value={form.cardId} onChange={(e) => setForm({ ...form, cardId: Number(e.target.value) })}>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.currency})
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Фактически списано, ${card?.currency ?? ''}`}>
            <input
              value={form.actual}
              onChange={(e) => setForm({ ...form, actual: e.target.value })}
              inputMode="decimal"
              placeholder="10,50"
            />
          </Field>
          {card && card.currency !== 'RUB' && (
            <Field
              label={`Курс ${card.currency}→₽ (по умолчанию ${rateHint?.cur === card.currency ? rateHint.text : '…'})`}
            >
              <input
                value={form.rate}
                onChange={(e) => setForm({ ...form, rate: e.target.value })}
                inputMode="decimal"
                placeholder="оставьте пустым — принять курс"
              />
            </Field>
          )}
          <div className="sub">Скриншот списания можно приложить в чате с ботом.</div>
        </Card>
      )}

      {rateWarn && (
        <div className="warnbox">
          <b>Проверьте курс перед расчётом</b>
          {rateWarn.map((t) => (
            <div key={t} style={{ marginTop: 6 }}>
              {t}
            </div>
          ))}
          <Button busy={busy} onClick={() => void quote(true)}>
            Рассчитать всё равно
          </Button>
          <Button kind="secondary" onClick={() => setRateWarn(null)}>
            Отмена
          </Button>
        </div>
      )}
      {has('quote') && !rateWarn && (
        <Button busy={busy} onClick={() => void quote(false)}>
          🧮 Рассчитать
        </Button>
      )}
      {has('confirm_payment') && (
        <Button busy={busy} onClick={() => void simple('confirm-payment', 'Оплата подтверждена')}>
          ✅ Оплата получена
        </Button>
      )}
      {has('payment_not_found') && (
        <Button kind="secondary" busy={busy} onClick={() => void simple('payment-not-found', 'Клиенту отправлено')}>
          🚫 Оплата не найдена
        </Button>
      )}
      {has('complete') && (
        <Button
          busy={busy}
          disabled={panel === 'complete' && (!form.actual || !form.cardId)}
          onClick={() => (panel === 'complete' ? void complete() : setPanel('complete'))}
        >
          ✅ Выполнено
        </Button>
      )}
      {has('link_invalid') && (
        <Button kind="secondary" busy={busy} onClick={() => void simple('link-invalid', 'Клиент уведомлён')}>
          ⛓ Ссылка не работает
        </Button>
      )}
      {has('reject') && (
        <Button
          kind="danger"
          busy={busy}
          disabled={panel === 'reject' && reason.trim().length < 2}
          onClick={() =>
            panel === 'reject' ? void simple('reject', 'Заявка отклонена', { reason }) : setPanel('reject')
          }
        >
          {panel === 'reject' ? 'Отклонить заявку' : '❌ Отклонить'}
        </Button>
      )}
      {panel && (
        <Button kind="secondary" onClick={() => setPanel(null)}>
          Назад
        </Button>
      )}
    </>
  );
}

// ── Статистика ───────────────────────────────────────────────
const PERIODS: Array<[string, string]> = [
  ['month', 'Месяц'],
  ['prev', 'Прошлый'],
  ['week', 'Неделя'],
  ['today', 'Сегодня'],
  ['all', 'Всё время'],
];

export function StatsScreen() {
  const [period, setPeriod] = useState('month');
  const { data, error, loading, reload } = useLoad(() => api.stats(period), [period]);
  return (
    <>
      <h1>Статистика</h1>
      <div className="chips">
        {PERIODS.map(([v, l]) => (
          <button key={v} className={v === period ? 'on' : ''} onClick={() => setPeriod(v)}>
            {l}
          </button>
        ))}
      </div>
      {loading && !data && <Spinner />}
      {error && <ErrorBox text={error} onRetry={reload} />}
      {data && <StatsBody s={data} />}
    </>
  );
}

function StatsBody({ s }: { s: Stats }) {
  const created = Object.values(s.created).reduce((a, b) => a + b, 0);
  return (
    <>
      <Card>
        <div className="sub">Период: {s.label}</div>
        <Row k="Создано заявок">{created}</Row>
        <Row k="Выполнено">{s.count}</Row>
        <Row k="Оборот">
          <b>{rub(s.turnoverMinor)}</b>
        </Row>
        <Row k="Расходы">{rub(s.costMinor)}</Row>
        <Row k="Валовая прибыль">
          <b>{rub(s.profitMinor)}</b>
        </Row>
        <Row k="Пополнения">{rub(s.topUpMinor)}</Row>
        <Row k="Погашено долгов">{rub(s.repaidMinor)}</Row>
      </Card>
      {s.count > 0 && (
        <>
          <h2>По клиентам</h2>
          <Card>
            {s.byClient.map((r) => (
              <Row key={r.label} k={`${r.label} (${r.count})`}>
                {rub(r.turnoverMinor)}
              </Row>
            ))}
          </Card>
          <h2>По сервисам</h2>
          <Card>
            {s.byService.map((r) => (
              <Row key={r.label} k={`${r.label} (${r.count})`}>
                {rub(r.turnoverMinor)}
              </Row>
            ))}
          </Card>
          <h2>По картам</h2>
          <Card>
            {s.byCard.map((c) => (
              <Row key={`${c.label}${c.currency}`} k={`${c.label} (${c.count})`}>
                {money(c.chargeMinor, c.currency)} ≈ {rub(c.rubMinor)}
              </Row>
            ))}
          </Card>
        </>
      )}
    </>
  );
}
