-- Способ перевода выбирает админ и присылает реквизиты сам: у пополнения способа может ещё не быть.
ALTER TABLE "TopUp" ALTER COLUMN "methodId" DROP NOT NULL;

-- Заготовки первого запуска: «Перевод на карту» -> «Прямой перевод», пустые реквизиты вместо плейсхолдера
-- (реквизиты присылает админ вручную; текст в базе не хранится).
UPDATE "PaymentMethod" SET "title" = 'Прямой перевод'
  WHERE "title" = 'Перевод на карту' AND "instructions" LIKE 'Реквизиты не заданы%';
UPDATE "PaymentMethod" SET "instructions" = ''
  WHERE "instructions" LIKE 'Реквизиты не заданы%' OR "instructions" = 'Договоримся о встрече';
