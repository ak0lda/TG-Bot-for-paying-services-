import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { haptic } from './tg';

// ── Хуки ──────────────────────────────────────────────────────
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => my === seq.current && setState({ data, error: null, loading: false }),
      (e: unknown) => my === seq.current && setState({ data: null, error: errorText(e), loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run, setData: (data: T) => setState({ data, error: null, loading: false }) };
}

export const errorText = (e: unknown): string =>
  e instanceof ApiError ? e.message : e instanceof Error && e.message ? 'Нет связи с сервером' : 'Что-то пошло не так';

// ── Уведомления ───────────────────────────────────────────────
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'bad') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'bad' } | null>(null);
  const timer = useRef<number>();
  const show = useCallback((text: string, kind: 'ok' | 'bad' = 'ok') => {
    window.clearTimeout(timer.current);
    setToast({ text, kind });
    (kind === 'ok' ? haptic.ok : haptic.error)();
    timer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </ToastCtx.Provider>
  );
}

/**
 * Обёртка действия: блокирует кнопки на время запроса и показывает понятную ошибку.
 * Если заявка уже изменилась (409 stale) — перезагружает данные вместо молчаливого сбоя.
 */
export function useAction(onStale?: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string, onError?: (e: unknown) => void): Promise<T | undefined> => {
      if (busy) return undefined;
      setBusy(true);
      try {
        const res = await fn();
        if (okText) toast(okText);
        return res;
      } catch (e) {
        onError?.(e);
        if (e instanceof ApiError && e.code === 'stale') {
          toast('Заявка уже изменилась — обновил данные', 'bad');
          onStale?.();
        } else toast(errorText(e), 'bad');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [busy, toast, onStale],
  );
  return { busy, run };
}

// ── Компоненты ────────────────────────────────────────────────
export const Spinner = () => <div className="spinner" role="progressbar" aria-label="Загрузка" />;

export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="errbox">
      {text}
      {onRetry && <button className="btn secondary" onClick={onRetry}>Повторить</button>}
    </div>
  );
}

export const Card = ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
  <div className={`card${onClick ? ' click' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined}>{children}</div>
);

export const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="row"><span className="k">{k}</span><span className="v">{children}</span></div>
);

export function Badge({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return <span className={`badge${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function statusTone(status: string): 'ok' | 'warn' | 'bad' | undefined {
  if (status === 'DONE') return 'ok';
  if (['REJECTED', 'CANCELED', 'LINK_INVALID', 'EXPIRED'].includes(status)) return 'bad';
  if (['PAYMENT_CHECK', 'AWAITING_PAYMENT'].includes(status)) return 'warn';
  return undefined;
}

export function Button({
  children, onClick, kind, busy, disabled, type = 'button',
}: { children: ReactNode; onClick?: () => void; kind?: 'secondary' | 'danger'; busy?: boolean; disabled?: boolean; type?: 'button' | 'submit' }) {
  return (
    <button type={type} className={`btn${kind ? ` ${kind}` : ''}`} onClick={onClick} disabled={busy || disabled}>
      {busy ? 'Подождите…' : children}
    </button>
  );
}

export function Field({ label, error, children }: { label: string; error?: string | undefined; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
