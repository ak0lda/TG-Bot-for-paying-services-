import type { Db } from '../db/client.js';
import { defaultSettings, isSettingKey, SETTING_KEYS, type SettingKey, type Settings } from '../domain/settings.js';

export class SettingsService {
  constructor(private readonly db: Db) {}

  async getAll(): Promise<Settings> {
    const result = defaultSettings();
    const rows = await this.db.setting.findMany({ where: { key: { in: SETTING_KEYS } } });
    for (const row of rows) {
      if (isSettingKey(row.key) && typeof row.value === 'number') result[row.key] = row.value;
    }
    return result;
  }

  async set(key: SettingKey, value: number): Promise<void> {
    await this.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}
