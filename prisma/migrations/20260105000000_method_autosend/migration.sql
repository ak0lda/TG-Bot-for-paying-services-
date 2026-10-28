-- Автоотправка реквизитов по сумме: способ может иметь границы суммы и флаг автоотправки.
ALTER TABLE "PaymentMethod" ADD COLUMN "autoSend" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PaymentMethod" ADD COLUMN "minAmountMinor" BIGINT;
ALTER TABLE "PaymentMethod" ADD COLUMN "maxAmountMinor" BIGINT;
