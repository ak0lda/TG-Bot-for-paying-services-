import {
  backButton,
  closeMiniApp,
  hapticFeedback,
  init,
  miniApp,
  openLink,
  retrieveRawInitData,
  themeParams,
} from '@telegram-apps/sdk';

/** Безопасно вызывает необязательную возможность SDK: в старых клиентах Telegram её может не быть. */
function tryDo(fn: () => void): void {
  try {
    fn();
  } catch {
    /* возможность недоступна в этом клиенте */
  }
}

export interface TgBoot {
  /** Сырая строка initData для подписи запросов; null — приложение открыто вне Telegram. */
  initData: string | null;
}

function rawInitDataFromHash(): string | null {
  const v = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('tgWebAppData');
  return v && v.includes('hash=') ? v : null;
}

let booted: TgBoot | null = null;

/** Инициализация SDK выполняется один раз (повторный init() кидает ошибку, например при StrictMode). */
export function bootTelegram(): TgBoot {
  booted ??= doBoot();
  return booted;
}

function doBoot(): TgBoot {
  // initData берём отдельно от init(): запуск параметров из URL не зависит от возможности слать события клиенту.
  let initData: string | null;
  try {
    initData = retrieveRawInitData() ?? null;
  } catch (e) {
    // SDK строго разбирает параметры запуска; для нашей задачи достаточно сырой строки initData из URL-хеша.
    initData = rawInitDataFromHash();
    if (!initData) {
      console.warn('Telegram launch params unavailable:', e instanceof Error ? e.message : e);
      return { initData: null };
    }
  }
  if (!initData) return { initData: null };

  tryDo(() => init());
  tryDo(() => {
    themeParams.mountSync();
    themeParams.bindCssVars();
  });
  tryDo(() => {
    miniApp.mountSync();
    miniApp.bindCssVars();
    miniApp.ready();
  });
  tryDo(() => backButton.mount());
  return { initData };
}

export function showBack(onBack: (() => void) | null): () => void {
  let off: (() => void) | undefined;
  tryDo(() => {
    if (onBack) {
      off = backButton.onClick(onBack);
      backButton.show();
    } else {
      backButton.hide();
    }
  });
  return () => tryDo(() => off?.());
}

export const haptic = {
  ok: () => tryDo(() => hapticFeedback.notificationOccurred('success')),
  error: () => tryDo(() => hapticFeedback.notificationOccurred('error')),
};

export function openExternal(url: string): void {
  try {
    openLink(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** Закрывает приложение — пользователь остаётся в чате с ботом (там отправляют чеки). */
export function backToChat(): void {
  try {
    closeMiniApp();
  } catch {
    window.close();
  }
}
