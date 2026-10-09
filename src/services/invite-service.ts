import type { Invite, User } from '@prisma/client';
import type { Db } from '../db/client.js';
import { generateInviteCode, isValidInviteCodeFormat } from '../domain/invite-code.js';
import type { TgIdentity } from './user-service.js';

export type RedeemResult =
  | { ok: true; user: User; invite: Invite }
  | { ok: false; reason: 'invalid' };

class InviteRejected extends Error {}

export class InviteService {
  constructor(private readonly db: Db) {}

  create(createdById: number, ttlHours: number, note?: string): Promise<Invite> {
    return this.db.invite.create({
      data: {
        code: generateInviteCode(),
        note: note ?? null,
        createdById,
        expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
      },
    });
  }

  listActive(): Promise<Invite[]> {
    return this.db.invite.findMany({
      where: { usedById: null, expiresAt: { gt: new Date() } },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * Одноразовое погашение: пользователь создаётся и инвайт помечается использованным
   * в одной транзакции; условный updateMany защищает от гонки двух одновременных /start.
   */
  async redeem(code: string, tg: TgIdentity): Promise<RedeemResult> {
    if (!isValidInviteCodeFormat(code)) return { ok: false, reason: 'invalid' };
    try {
      return await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { telegramId: tg.id, username: tg.username ?? null, displayName: tg.displayName, role: 'CLIENT' },
        });
        const claimed = await tx.invite.updateMany({
          where: { code, usedById: null, expiresAt: { gt: new Date() } },
          data: { usedById: user.id, usedAt: new Date() },
        });
        if (claimed.count !== 1) throw new InviteRejected();
        const invite = await tx.invite.findUniqueOrThrow({ where: { code } });
        return { ok: true as const, user, invite };
      });
    } catch (e) {
      if (e instanceof InviteRejected) return { ok: false, reason: 'invalid' };
      throw e;
    }
  }
}
