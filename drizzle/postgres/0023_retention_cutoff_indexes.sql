CREATE INDEX IF NOT EXISTS "idx_transactions_date" ON "transactions" USING btree ("date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_monthly_budgets_year_month" ON "monthly_budgets" USING btree ("year_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_balance_snapshots_date" ON "account_balance_snapshots" USING btree ("snapshot_date");