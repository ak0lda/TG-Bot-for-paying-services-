-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'CLIENT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('PAYMENT_LINK', 'GIFT_CARD', 'TOP_UP', 'OTHER');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_CHECK', 'IN_PROGRESS', 'DONE', 'CANCELED', 'REJECTED', 'EXPIRED', 'LINK_INVALID');

-- CreateEnum
CREATE TYPE "PayMode" AS ENUM ('PREPAY', 'BALANCE', 'PAY_LATER');

-- CreateEnum
CREATE TYPE "PeriodKind" AS ENUM ('MONTH', 'YEAR', 'CUSTOM');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('TOPUP', 'ORDER_RESERVE', 'ORDER_RELEASE', 'ORDER_CHARGE', 'PAYMENT_RECEIVED', 'DIFF_ADJUST', 'MANUAL_ADJUST', 'DEBT_OPEN', 'DEBT_REPAY');

-- CreateEnum
CREATE TYPE "TopUpStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('RECEIPT', 'SCREENSHOT');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CLIENT',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "payLaterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payLaterLimitMinor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "createdById" INTEGER NOT NULL,
    "usedById" INTEGER,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TrustedDomain" (
    "id" SERIAL NOT NULL,
    "domain" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustedDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "requiresReceipt" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminCard" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AdminCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "clientId" INTEGER NOT NULL,
    "type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "service" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT,
    "urlDomain" TEXT,
    "giftStore" TEXT,
    "giftRegion" TEXT,
    "giftDenomination" TEXT,
    "amountMinor" BIGINT,
    "currency" TEXT,
    "isSubscription" BOOLEAN NOT NULL DEFAULT false,
    "periodKind" "PeriodKind",
    "periodDays" INTEGER,
    "nextChargeAt" TIMESTAMP(3),
    "renewedFromId" INTEGER,
    "comment" TEXT,
    "payMode" "PayMode" NOT NULL DEFAULT 'PREPAY',
    "payMethodId" INTEGER,
    "rate" DECIMAL(18,8),
    "rateSource" TEXT,
    "rateAt" TIMESTAMP(3),
    "fxBufferBp" INTEGER,
    "markupBp" INTEGER,
    "fixedFeeMinor" BIGINT,
    "totalMinor" BIGINT,
    "quotedAt" TIMESTAMP(3),
    "quoteExpiresAt" TIMESTAMP(3),
    "reservedMinor" BIGINT NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "actualChargeMinor" BIGINT,
    "actualCurrency" TEXT,
    "cardId" INTEGER,
    "diffMinor" BIGINT,
    "rejectReason" TEXT,
    "giftCodeEnc" BYTEA,
    "giftCodeDeleteAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "actorId" INTEGER,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopUp" (
    "id" SERIAL NOT NULL,
    "clientId" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "methodId" INTEGER NOT NULL,
    "status" "TopUpStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER,
    "topUpId" INTEGER,
    "kind" "AttachmentKind" NOT NULL,
    "tgFileId" TEXT NOT NULL,
    "uploadedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" SERIAL NOT NULL,
    "clientId" INTEGER NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "orderId" INTEGER,
    "topUpId" INTEGER,
    "comment" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_code_key" ON "Invite"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_usedById_key" ON "Invite"("usedById");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDomain_domain_key" ON "TrustedDomain"("domain");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_clientId_idx" ON "Order"("clientId");

-- CreateIndex
CREATE INDEX "Order_nextChargeAt_idx" ON "Order"("nextChargeAt");

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_idx" ON "OrderEvent"("orderId");

-- CreateIndex
CREATE INDEX "LedgerEntry_clientId_idx" ON "LedgerEntry"("clientId");

-- CreateIndex
CREATE INDEX "LedgerEntry_orderId_idx" ON "LedgerEntry"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_key_key" ON "Reminder"("key");

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_renewedFromId_fkey" FOREIGN KEY ("renewedFromId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_payMethodId_fkey" FOREIGN KEY ("payMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "AdminCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopUp" ADD CONSTRAINT "TopUp_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopUp" ADD CONSTRAINT "TopUp_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "PaymentMethod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_topUpId_fkey" FOREIGN KEY ("topUpId") REFERENCES "TopUp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_topUpId_fkey" FOREIGN KEY ("topUpId") REFERENCES "TopUp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Append-only: журнал операций и журнал событий заявок нельзя менять или удалять.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_append_only
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER order_event_append_only
  BEFORE UPDATE OR DELETE ON "OrderEvent"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
