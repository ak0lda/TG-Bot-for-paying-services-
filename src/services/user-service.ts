import type { User } from '@prisma/client';
import type { Db } from '../db/client.js';

export interface TgIdentity {
  id: bigint;
  username?: string | undefined;
  displayName: string;
}

export class UserService {
  constructor(private readonly db: Db) {}

  findByTelegramId(telegramId: bigint): Promise<User | null> {
    return this.db.user.findUnique({ where: { telegramId } });
  }

  /** Админ создаётся/обновляется автоматически по ADMIN_TELEGRAM_ID. */
  upsertAdmin(tg: TgIdentity): Promise<User> {
    return this.db.user.upsert({
      where: { telegramId: tg.id },
      create: { telegramId: tg.id, username: tg.username ?? null, displayName: tg.displayName, role: 'ADMIN' },
      update: { username: tg.username ?? null, displayName: tg.displayName, role: 'ADMIN', status: 'ACTIVE' },
    });
  }

  listClients(): Promise<User[]> {
    return this.db.user.findMany({ where: { role: 'CLIENT' }, orderBy: { id: 'asc' } });
  }

  getClient(id: number): Promise<User | null> {
    return this.db.user.findFirst({ where: { id, role: 'CLIENT' } });
  }

  setStatus(id: number, status: 'ACTIVE' | 'BLOCKED'): Promise<User> {
    return this.db.user.update({ where: { id }, data: { status } });
  }

  setPayLater(id: number, enabled: boolean, limitMinor?: bigint): Promise<User> {
    return this.db.user.update({
      where: { id },
      data: { payLaterEnabled: enabled, ...(limitMinor !== undefined ? { payLaterLimitMinor: limitMinor } : {}) },
    });
  }
}
