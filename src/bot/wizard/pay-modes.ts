import type { PayMode } from '@prisma/client';
import type { Deps } from '../context.js';
import { availableOf, payLaterExposure } from '../../domain/ledger.js';
import { formatRub } from '../../domain/money.js';
import { balanceOf } from '../../services/ledger-service.js';
import { o as ot } from '../../texts/orders.js';

/** Доступные клиенту режимы оплаты (PREPAY — всегда). */
export async function availableModes(
  deps: Pick<Deps, 'db'>,
  clientId: number,
): Promise<Array<{ mode: PayMode; label: string }>> {
  const user = await deps.db.user.findUniqueOrThrow({ where: { id: clientId } });
  const balance = await balanceOf(deps.db, clientId);
  const modes: Array<{ mode: PayMode; label: string }> = [{ mode: 'PREPAY', label: ot.payModeLabel.PREPAY }];
  if (availableOf(balance) > 0n) modes.push({ mode: 'BALANCE', label: ot.payModeLabel.BALANCE(formatRub(availableOf(balance))) });
  if (user.payLaterEnabled && user.payLaterLimitMinor > 0n) {
    const open = await deps.db.order.aggregate({
      where: { clientId, payMode: 'PAY_LATER', status: { in: ['IN_PROGRESS', 'LINK_INVALID'] } },
      _sum: { totalMinor: true },
    });
    const used = payLaterExposure(balance, open._sum.totalMinor ?? 0n, 0n);
    if (used < user.payLaterLimitMinor) {
      modes.push({ mode: 'PAY_LATER', label: ot.payModeLabel.PAY_LATER(formatRub(user.payLaterLimitMinor - used)) });
    }
  }
  return modes;
}
