-- Per-month paydown snapshots. When the user clicks "Save to Budget" on
-- the Pay down page, we copy each credit/loan account's planned payment
-- into this table keyed by (user, account, year_month). The Budget
-- page's Pay down modal reads from this table to show planned per
-- account for the selected month.
--
-- Same shape as `monthly_budgets` — composite PK on
-- (user_id, account_id, year_month), no FK on account_id so the row
-- survives account deletion. Hidden accounts are filtered at READ time
-- (the modal joins against `accounts` and skips hidden rows) so users
-- can un-hide later without losing the snapshot.
--
-- A second tiny table records "when did the user last bulk-sync the
-- month" so the modal can render "Last synced: 5m ago via Pay down
-- page". Pulled out of monthly_paydown (vs MAX(updated_at)) because
-- editing a single account row advances updated_at too — that signal
-- is noisier than the user's explicit save-to-budget action.
CREATE TABLE "monthly_paydown" (
  "user_id" text NOT NULL,
  "account_id" text NOT NULL,
  "year_month" text NOT NULL,
  "planned" double precision NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "account_id", "year_month")
);

CREATE TABLE "monthly_paydown_snapshots" (
  "user_id" text NOT NULL,
  "year_month" text NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "row_count" integer NOT NULL,
  PRIMARY KEY ("user_id", "year_month")
);

CREATE INDEX "idx_monthly_paydown_user" ON "monthly_paydown" USING btree ("user_id");
CREATE INDEX "idx_monthly_paydown_snapshots_user" ON "monthly_paydown_snapshots" USING btree ("user_id");
