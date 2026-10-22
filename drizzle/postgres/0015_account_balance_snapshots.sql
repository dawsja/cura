-- Daily balance snapshots for investment accounts. Investments are
-- balance-only (no ledger transactions), so market movement can't be
-- reconstructed from cash flow. Every balance write (SimpleFIN sync or
-- manual edit) upserts one row per (user, account, calendar day). The
-- Reports investment chart reads these to draw one line per account.
--
-- No FK on account_id so snapshots survive account deletion — orphans
-- are filtered at read time against the live accounts table. Retention
-- purges rows older than the standard previous-year floor.
CREATE TABLE "account_balance_snapshots" (
  "user_id" text NOT NULL,
  "account_id" text NOT NULL,
  "snapshot_date" text NOT NULL,
  "balance" double precision NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "account_id", "snapshot_date")
);

CREATE INDEX "idx_account_balance_snapshots_user" ON "account_balance_snapshots" USING btree ("user_id");
CREATE INDEX "idx_account_balance_snapshots_user_date" ON "account_balance_snapshots" USING btree ("user_id", "snapshot_date");
