import type { Context } from 'grammy';
import type { User } from '@prisma/client';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import type { InviteService } from '../services/invite-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { TrustedDomainService } from '../services/domain-service.js';
import type { UserService } from '../services/user-service.js';
import type { OrderService } from '../services/order-service.js';
import type { RatesService } from '../services/rates.js';
import type { CatalogService } from '../services/catalog-service.js';
import type { ReportService } from '../services/report-service.js';
import type { TopUpService } from '../services/topup-service.js';
import type { AlertService } from '../services/alerts.js';
import type { Notifier } from '../services/notifier.js';
import type { Presenter } from './presenter.js';
import type { WizardManager } from './wizard/engine.js';

export interface Deps {
  config: Config;
  db: Db;
  log: Logger;
  users: UserService;
  invites: InviteService;
  settings: SettingsService;
  domains: TrustedDomainService;
  orders: OrderService;
  topups: TopUpService;
  reports: ReportService;
  rates: RatesService;
  catalog: CatalogService;
  notifier: Notifier;
  alerts: AlertService;
  presenter: Presenter;
  wizards: WizardManager;
}

export type Access = 'ok' | 'blocked' | 'unknown';

export type BotContext = Context & {
  /** Зарегистрированный пользователь (только при access === 'ok'). */
  appUser?: User;
  access: Access;
};
