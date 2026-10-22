ALTER TABLE "transactions" ADD COLUMN "amount_cents" bigint;
UPDATE "transactions" SET "amount_cents" = ROUND("amount"::numeric * 100)::bigint;
ALTER TABLE "transactions" ALTER COLUMN "amount_cents" SET NOT NULL;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_cents_safe_integer"
  CHECK ("amount_cents" BETWEEN -9007199254740991 AND 9007199254740991);
ALTER TABLE "transactions" DROP COLUMN "amount";

DROP INDEX "idx_transactions_external";
CREATE UNIQUE INDEX "idx_transactions_user_external" ON "transactions" USING btree ("user_id", "external_id");
