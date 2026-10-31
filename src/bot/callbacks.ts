export type OrderAction =
  | 'v' // просмотр
  | 'q' // админ: рассчитать
  | 'qf' // админ: рассчитать, несмотря на предупреждения по курсу
  | 'rq' // пересчитать (админ/клиент)
  | 'pc' // админ: оплата получена
  | 'pn' // админ: оплата не найдена
  | 'lk' // админ: ссылка не работает
  | 'dn' // админ: выполнено
  | 'rj' // админ: отклонить
  | 'cf' // клиент: подтвердить расчёт
  | 'pd' // клиент: я оплатил
  | 'cx' // клиент: отменить
  | 'nl' // клиент: прислать новую ссылку
  | 'ro'; // клиент: повторить заявку

const ACTIONS: readonly string[] = ['v', 'q', 'qf', 'rq', 'pc', 'pn', 'lk', 'dn', 'rj', 'cf', 'pd', 'cx', 'nl', 'ro'];

/** Версия заявки зашита в кнопку: после любого перехода старые кнопки становятся «устаревшими». */
export const orderCb = (id: number, version: number, action: OrderAction): string => `o:${id}:${version}:${action}`;

export function parseOrderCb(data: string): { id: number; version: number; action: OrderAction } | null {
  const m = /^o:(\d+):(\d+):([a-z]{1,2})$/.exec(data);
  if (!m || !ACTIONS.includes(m[3]!)) return null;
  return { id: Number(m[1]), version: Number(m[2]), action: m[3] as OrderAction };
}

export const wizardCb = (step: string, value: string): string => `w:${step}:${value}`;
export const WIZARD_CANCEL = 'w:x';
