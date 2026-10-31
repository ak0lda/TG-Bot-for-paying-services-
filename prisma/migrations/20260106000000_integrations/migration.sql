-- CreateEnum
CREATE TYPE "TopUpKind" AS ENUM ('TRANSFER', 'USDT_TRC20');

-- DropForeignKey
ALTER TABLE "TopUp" DROP CONSTRAINT "TopUp_methodId_fkey";

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "tgFileUniqueId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "linkRisk" TEXT;

-- AlterTable
ALTER TABLE "TopUp" ADD COLUMN     "cryptoAmountMicro" BIGINT,
ADD COLUMN     "cryptoRateScaled" BIGINT,
ADD COLUMN     "cryptoTxId" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "kind" "TopUpKind" NOT NULL DEFAULT 'TRANSFER';

-- CreateTable
CREATE TABLE "CryptoTransfer" (
    "id" SERIAL NOT NULL,
    "txid" TEXT NOT NULL,
    "amountMicro" BIGINT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "blockTimestamp" TIMESTAMP(3) NOT NULL,
    "topUpId" INTEGER,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CryptoTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedDomain" (
    "id" SERIAL NOT NULL,
    "domain" TEXT NOT NULL,
    "reason" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePreset" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OrderType" NOT NULL DEFAULT 'PAYMENT_LINK',
    "currency" TEXT,
    "amountMinor" BIGINT,
    "periodKind" "PeriodKind",
    "periodDays" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ServicePreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CryptoTransfer_txid_key" ON "CryptoTransfer"("txid");

-- CreateIndex
CREATE INDEX "CryptoTransfer_topUpId_idx" ON "CryptoTransfer"("topUpId");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedDomain_domain_key" ON "BlockedDomain"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePreset_name_key" ON "ServicePreset"("name");

-- CreateIndex
CREATE INDEX "Attachment_tgFileUniqueId_idx" ON "Attachment"("tgFileUniqueId");

-- CreateIndex
CREATE UNIQUE INDEX "TopUp_cryptoTxId_key" ON "TopUp"("cryptoTxId");

-- AddForeignKey
ALTER TABLE "TopUp" ADD CONSTRAINT "TopUp_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoTransfer" ADD CONSTRAINT "CryptoTransfer_topUpId_fkey" FOREIGN KEY ("topUpId") REFERENCES "TopUp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

