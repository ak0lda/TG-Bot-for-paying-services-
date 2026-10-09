import type { Api } from 'grammy';
import type { InlineKeyboard } from 'grammy';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

export interface Attachment {
  fileId: string;
  fileType: 'photo' | 'document';
}

/** Отправка уведомлений. Ошибки доставки (бот заблокирован и т.п.) логируются, но не ломают бизнес-операцию. */
export class Notifier {
  constructor(
    private readonly api: Api,
    private readonly config: Pick<Config, 'ADMIN_CHAT_ID' | 'ADMIN_TELEGRAM_ID'>,
    private readonly log: Logger,
  ) {}

  private get adminChat(): number {
    return Number(this.config.ADMIN_CHAT_ID ?? this.config.ADMIN_TELEGRAM_ID);
  }

  toClient(telegramId: bigint, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    return this.send(Number(telegramId), text, keyboard);
  }

  toAdmin(text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    return this.send(this.adminChat, text, keyboard);
  }

  async attachmentToAdmin(a: Attachment, caption?: string): Promise<void> {
    try {
      if (a.fileType === 'photo') await this.api.sendPhoto(this.adminChat, a.fileId, caption ? { caption } : {});
      else await this.api.sendDocument(this.adminChat, a.fileId, caption ? { caption } : {});
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'attachment delivery failed');
    }
  }

  private async send(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    try {
      await this.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      return true;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'notification failed');
      return false;
    }
  }
}
