import type { Api } from 'grammy';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Logger } from './logger.js';
import type { Deps } from './bot/context.js';
import { Presenter } from './bot/presenter.js';
import { WizardManager } from './bot/wizard/engine.js';
import { CatalogService } from './services/catalog-service.js';
import { InviteService } from './services/invite-service.js';
import { Notifier } from './services/notifier.js';
import { OrderService } from './services/order-service.js';
import { RatesService } from './services/rates.js';
import { SettingsService } from './services/settings-service.js';
import { TrustedDomainService } from './services/domain-service.js';
import { ReportService } from './services/report-service.js';
import { TopUpService } from './services/topup-service.js';
import { UserService } from './services/user-service.js';

/** Сборка графа зависимостей (используется и в index.ts, и в e2e-тестах). */
export function buildDeps(config: Config, db: Db, log: Logger, api: Api): Deps {
  const settings = new SettingsService(db);
  const domains = new TrustedDomainService(db);
  const rates = new RatesService(db, log);
  const catalog = new CatalogService(db);
  const notifier = new Notifier(api, config, log);
  return {
    config,
    db,
    log,
    users: new UserService(db),
    invites: new InviteService(db),
    settings,
    domains,
    rates,
    catalog,
    notifier,
    topups: new TopUpService(db),
    reports: new ReportService(db),
    orders: new OrderService(db, rates, settings, config.ENCRYPTION_KEY),
    presenter: new Presenter({ domains, settings, config, catalog, notifier }),
    wizards: new WizardManager(),
  };
}
