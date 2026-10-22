ALTER TABLE "accounts" DROP CONSTRAINT "accounts_balance_range";--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_interest_rate_range";--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_min_payment_range";--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_planned_payment_range";--> statement-breakpoint
ALTER TABLE "sub_categories" DROP CONSTRAINT "sub_categories_planned_range";--> statement-breakpoint
ALTER TABLE "monthly_budgets" DROP CONSTRAINT "monthly_budgets_planned_range";--> statement-breakpoint
ALTER TABLE "goals" DROP CONSTRAINT "goals_target_range";--> statement-breakpoint
ALTER TABLE "goals" DROP CONSTRAINT "goals_starting_value_range";--> statement-breakpoint
ALTER TABLE "monthly_paydown" DROP CONSTRAINT "monthly_paydown_planned_range";--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" DROP CONSTRAINT "account_balance_snapshots_balance_range";--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "balance" SET DATA TYPE numeric(16,2) USING round("balance"::numeric, 2);--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "interest_rate" SET DATA TYPE numeric(12,10) USING round("interest_rate"::numeric, 10);--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "min_payment" SET DATA TYPE numeric(16,2) USING round("min_payment"::numeric, 2);--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "planned_payment" SET DATA TYPE numeric(16,2) USING round("planned_payment"::numeric, 2);--> statement-breakpoint
ALTER TABLE "sub_categories" ALTER COLUMN "planned" SET DATA TYPE numeric(16,2) USING round("planned"::numeric, 2);--> statement-breakpoint
ALTER TABLE "monthly_budgets" ALTER COLUMN "planned" SET DATA TYPE numeric(16,2) USING round("planned"::numeric, 2);--> statement-breakpoint
ALTER TABLE "goals" ALTER COLUMN "target" SET DATA TYPE numeric(16,2) USING greatest(0.01, round("target"::numeric, 2));--> statement-breakpoint
ALTER TABLE "goals" ALTER COLUMN "starting_value" SET DATA TYPE numeric(16,2) USING round("starting_value"::numeric, 2);--> statement-breakpoint
ALTER TABLE "monthly_paydown" ALTER COLUMN "planned" SET DATA TYPE numeric(16,2) USING round("planned"::numeric, 2);--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ALTER COLUMN "balance" SET DATA TYPE numeric(16,2) USING round("balance"::numeric, 2);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_balance_range" CHECK ("accounts"."balance" BETWEEN -90000000000000 AND 90000000000000);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_interest_rate_range" CHECK ("accounts"."interest_rate" BETWEEN 0 AND 1);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_min_payment_range" CHECK ("accounts"."min_payment" BETWEEN 0 AND 90000000000000);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_planned_payment_range" CHECK ("accounts"."planned_payment" BETWEEN 0 AND 90000000000000);--> statement-breakpoint
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_planned_range" CHECK ("sub_categories"."planned" BETWEEN 0 AND 90000000000000);--> statement-breakpoint
ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_planned_range" CHECK ("monthly_budgets"."planned" BETWEEN 0 AND 90000000000000);--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_target_range" CHECK ("goals"."target" > 0 AND "goals"."target" <= 90000000000000);--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_starting_value_range" CHECK ("goals"."starting_value" BETWEEN 0 AND 90000000000000);--> statement-breakpoint
ALTER TABLE "monthly_paydown" ADD CONSTRAINT "monthly_paydown_planned_range" CHECK ("monthly_paydown"."planned" BETWEEN 0 AND 90000000000000);--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_balance_range" CHECK ("account_balance_snapshots"."balance" BETWEEN -90000000000000 AND 90000000000000);
