import type { Context } from 'grammy';
import type { User } from '@prisma/client';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import type { InviteService } from '../services/invite-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { TrustedDomainService } from '../services/domain-service.js';
import type { UserService } from '../services/user-service.js';

export interface Deps {
  config: Config;
  db: Db;
  log: Logger;
  users: UserService;
  invites: InviteService;
  settings: SettingsService;
  domains: TrustedDomainService;
}

export type Access = 'ok' | 'blocked' | 'unknown';

export type BotContext = Context & {
  /** Зарегистрированный пользователь (только при access === 'ok'). */
  appUser?: User;
  access: Access;
};
