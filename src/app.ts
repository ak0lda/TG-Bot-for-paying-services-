import type { Api } from 'grammy';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Logger } from './logger.js';
import type { Deps } from './bot/context.js';
import { Presenter } from './bot/presenter.js';
import { WizardManager } from './bot/wizard/engine.js';
import { AlertService } from './services/alerts.js';
import { rw } from './texts/rates.js';
import { CatalogService } from './services/catalog-service.js';
import { InviteService } from './services/invite-service.js';
import { LinkSafetyService } from './services/link-safety.js';
import { Notifier } from './services/notifier.js';
import { OrderService } from './services/order-service.js';
import { RatesService } from './services/rates.js';
import { SettingsService } from './services/settings-service.js';
import { TrustedDomainService } from './services/domain-service.js';
import { ReportService } from './services/report-service.js';
import { TopUpService } from './services/topup-service.js';
import { UserService } from './services/user-service.js';

/** Сборка графа зависимостей (используется и в index.ts, и в e2e-тестах). */
export function buildDeps(
  config: Config,
  db: Db,
  log: Logger,
  api: Api,
  opts: { fetchRatesXml?: () => Promise<string>; linkSafetyFetch?: typeof fetch } = {},
): Deps {
  const settings = new SettingsService(db);
  const domains = new TrustedDomainService(db);
  const rates = new RatesService(db, log, opts.fetchRatesXml, undefined, settings);
  const catalog = new CatalogService(db);
  const notifier = new Notifier(api, config, log);
  const alerts = new AlertService(notifier, log);
  // Резкий скачок курса ЦБ по значимой валюте — сразу сообщаем админу (не чаще раза в 6 часов на валюту).
  rates.setAnomalyHandler(
    (a) => void alerts.alert(`rate-jump:${a.currency}`, rw.alertJump(a.currency, a.warning), 6 * 3_600_000),
  );
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
    alerts,
    linkSafety: new LinkSafetyService(db, log, { apiKey: config.SAFE_BROWSING_API_KEY, ...(opts.linkSafetyFetch ? { fetchFn: opts.linkSafetyFetch } : {}) }),
    topups: new TopUpService(db),
    reports: new ReportService(db),
    orders: new OrderService(db, rates, settings, config.keyring),
    presenter: new Presenter({ domains, settings, config, catalog, notifier }),
    wizards: new WizardManager(),
  };
}
