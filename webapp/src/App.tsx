import { useEffect, useMemo, useState } from 'react';
import { api, setInitData } from './api';
import { AdminOrder, Queue, StatsScreen } from './admin';
import { BalanceScreen, NewOrder, OrderDetail, OrderList } from './client';
import { bootTelegram, showBack } from './tg';
import type { Me } from './types';
import { ErrorBox, Spinner, ToastProvider, useLoad } from './ui';

type Tab = 'orders' | 'new' | 'balance' | 'queue' | 'stats';
type View = { tab: Tab; orderId: number | null };

const CLIENT_TABS: Array<[Tab, string]> = [['orders', '📋 Заявки'], ['new', '➕ Новая'], ['balance', '💰 Баланс']];
const ADMIN_TABS: Array<[Tab, string]> = [['queue', '📥 Очередь'], ['stats', '📊 Статистика']];

export function App() {
  const boot = useMemo(() => bootTelegram(), []);
  if (!boot.initData) {
    return (
      <div className="app">
        <h1>Оплата сервисов</h1>
        <div className="errbox">Откройте приложение из Telegram — кнопка «Приложение» в чате с ботом.</div>
      </div>
    );
  }
  setInitData(boot.initData);
  return (
    <ToastProvider>
      <Authed />
    </ToastProvider>
  );
}

function Authed() {
  const { data: me, error, loading, reload } = useLoad(() => api.me(), []);
  if (loading && !me) return <div className="app"><Spinner /></div>;
  if (error || !me) {
    return (
      <div className="app">
        <h1>Оплата сервисов</h1>
        <ErrorBox text={error ?? 'Не удалось загрузить профиль'} onRetry={reload} />
      </div>
    );
  }
  return <Shell me={me} />;
}

function Shell({ me }: { me: Me }) {
  const isAdmin = me.role === 'ADMIN';
  const tabs = isAdmin ? ADMIN_TABS : CLIENT_TABS;
  const [view, setView] = useState<View>({ tab: tabs[0]![0], orderId: null });
  const [rev, setRev] = useState(0); // счётчик «данные изменились» — перезагружает списки при возврате
  const bump = () => setRev((r) => r + 1);

  // Кнопка «Назад» Telegram: из карточки заявки — в список.
  useEffect(() => showBack(view.orderId !== null ? () => setView((v) => ({ ...v, orderId: null })) : null), [view.orderId]);

  const go = (tab: Tab) => setView({ tab, orderId: null });
  const openOrder = (orderId: number) => setView((v) => ({ ...v, orderId }));

  let body;
  if (view.orderId !== null) {
    body = isAdmin
      ? <AdminOrder key={view.orderId} id={view.orderId} me={me} onChanged={bump} />
      : <OrderDetail key={view.orderId} id={view.orderId} me={me} onChanged={bump} />;
  } else if (view.tab === 'orders') body = <OrderList key={rev} open={openOrder} />;
  else if (view.tab === 'new') body = <NewOrder me={me} created={(id) => { bump(); setView({ tab: 'orders', orderId: id }); }} />;
  else if (view.tab === 'balance') body = <BalanceScreen key={rev} />;
  else if (view.tab === 'queue') body = <Queue key={rev} open={openOrder} />;
  else body = <StatsScreen />;

  return (
    <>
      <div className="app">{body}</div>
      <nav className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={view.tab === t ? 'on' : ''} onClick={() => go(t)}>{label}</button>
        ))}
      </nav>
    </>
  );
}

