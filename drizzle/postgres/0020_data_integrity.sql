-- Stable account identity for ledger rows. Keep account as a display snapshot
-- for unresolved legacy rows and compatibility with existing API consumers.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "account_id" text;
--> statement-breakpoint
UPDATE "transactions" t
SET "account_id" = matched.id
FROM (
  SELECT user_id, name, MIN(id) AS id
  FROM "accounts"
  GROUP BY user_id, name
  HAVING COUNT(*) = 1
) matched
WHERE t.user_id = matched.user_id
  AND t.account = matched.name
  AND t.account_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transactions_user_account"
  ON "transactions" ("user_id", "account_id");
--> statement-breakpoint

-- Existing transaction values represented magnitudes; normalize any legacy
-- signed rows before tightening the invariant.
UPDATE "transactions" SET "amount_cents" = ABS("amount_cents") WHERE "amount_cents" < 0;
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_amount_cents_safe_integer";
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_cents_safe_integer"
  CHECK ("amount_cents" BETWEEN 0 AND 9007199254740991);
--> statement-breakpoint

-- Preserve every row repaired by this migration for operator recovery.
CREATE TABLE IF NOT EXISTS "migration_0020_data_archive" (
  "source_table" text NOT NULL,
  "reason" text NOT NULL,
  "row_data" jsonb NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Archive normalized rule twins before keeping the oldest authoritative row.
WITH ranked AS (
  SELECT r.*,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, lower(regexp_replace(btrim(match_value), '\s+', ' ', 'g'))
      ORDER BY created_at, id
    ) AS rn
  FROM "rules" r
)
INSERT INTO "migration_0020_data_archive" (source_table, reason, row_data)
SELECT 'rules', 'duplicate normalized merchant rule', to_jsonb(ranked) - 'rn'
FROM ranked WHERE rn > 1;
--> statement-breakpoint
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, lower(regexp_replace(btrim(match_value), '\s+', ' ', 'g'))
      ORDER BY created_at, id
    ) AS rn
  FROM "rules"
)
DELETE FROM "rules" r USING ranked
WHERE r.id = ranked.id AND ranked.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_rules_user_normalized_merchant"
  ON "rules" ("user_id", lower(regexp_replace(btrim("match_value"), '\s+', ' ', 'g')));
--> statement-breakpoint

-- Archive and repair impossible tenant references before composite FKs.
INSERT INTO "migration_0020_data_archive" (source_table, reason, row_data)
SELECT 'monthly_budgets', 'invalid tenant subcategory reference', to_jsonb(mb)
FROM "monthly_budgets" mb
WHERE NOT EXISTS (
  SELECT 1 FROM "sub_categories" sc
  WHERE sc.user_id = mb.user_id AND sc.id = mb.sub_category_id
);
--> statement-breakpoint
DELETE FROM "monthly_budgets" mb
WHERE NOT EXISTS (
  SELECT 1 FROM "sub_categories" sc
  WHERE sc.user_id = mb.user_id AND sc.id = mb.sub_category_id
);
--> statement-breakpoint
INSERT INTO "migration_0020_data_archive" (source_table, reason, row_data)
SELECT 'sub_categories', 'invalid tenant category reference', to_jsonb(sc)
FROM "sub_categories" sc
WHERE NOT EXISTS (
  SELECT 1 FROM "categories" c
  WHERE c.user_id = sc.user_id AND c.id = sc.main_category_id
);
--> statement-breakpoint
INSERT INTO "migration_0020_data_archive" (source_table, reason, row_data)
SELECT 'monthly_budgets', 'subcategory removed for invalid tenant category reference', to_jsonb(mb)
FROM "monthly_budgets" mb
JOIN "sub_categories" sc
  ON sc.user_id = mb.user_id AND sc.id = mb.sub_category_id
WHERE NOT EXISTS (
  SELECT 1 FROM "categories" c
  WHERE c.user_id = sc.user_id AND c.id = sc.main_category_id
);
--> statement-breakpoint
DELETE FROM "monthly_budgets" mb
USING "sub_categories" sc
WHERE sc.user_id = mb.user_id
  AND sc.id = mb.sub_category_id
  AND NOT EXISTS (
    SELECT 1 FROM "categories" c
    WHERE c.user_id = sc.user_id AND c.id = sc.main_category_id
  );
--> statement-breakpoint
DELETE FROM "sub_categories" sc
WHERE NOT EXISTS (
  SELECT 1 FROM "categories" c
  WHERE c.user_id = sc.user_id AND c.id = sc.main_category_id
);
--> statement-breakpoint
INSERT INTO "migration_0020_data_archive" (source_table, reason, row_data)
SELECT 'goals', 'invalid tenant account reference', to_jsonb(g)
FROM "goals" g
WHERE g.account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "accounts" a
    WHERE a.user_id = g.user_id AND a.id = g.account_id
  );
--> statement-breakpoint
UPDATE "goals" g SET "account_id" = NULL
WHERE g.account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "accounts" a
    WHERE a.user_id = g.user_id AND a.id = g.account_id
  );
--> statement-breakpoint

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_id_unique" UNIQUE ("user_id", "id");
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_id_unique" UNIQUE ("user_id", "id");
--> statement-breakpoint
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_user_id_id_unique" UNIQUE ("user_id", "id");
--> statement-breakpoint
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_user_category_fk"
  FOREIGN KEY ("user_id", "main_category_id")
  REFERENCES "categories" ("user_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_user_sub_category_fk"
  FOREIGN KEY ("user_id", "sub_category_id")
  REFERENCES "sub_categories" ("user_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_account_fk"
  FOREIGN KEY ("user_id", "account_id")
  REFERENCES "accounts" ("user_id", "id");
--> statement-breakpoint

-- Normalize non-finite/out-of-range floating values before enforcing bounded
-- arithmetic. 90 trillion dollars remains below JavaScript safe cents.
UPDATE "accounts" SET
  balance = CASE WHEN balance = 'NaN'::float8 THEN 0 ELSE LEAST(90000000000000, GREATEST(-90000000000000, balance)) END,
  interest_rate = CASE WHEN interest_rate = 'NaN'::float8 THEN 0 ELSE LEAST(1, GREATEST(0, interest_rate)) END,
  min_payment = CASE WHEN min_payment = 'NaN'::float8 THEN 0 ELSE LEAST(90000000000000, GREATEST(0, min_payment)) END,
  planned_payment = CASE WHEN planned_payment = 'NaN'::float8 THEN 0 ELSE LEAST(90000000000000, GREATEST(0, planned_payment)) END;
--> statement-breakpoint
UPDATE "sub_categories" SET planned = CASE WHEN planned = 'NaN'::float8 THEN 0 ELSE LEAST(90000000000000, GREATEST(0, planned)) END;
--> statement-breakpoint
UPDATE "monthly_budgets" SET planned = CASE WHEN planned = 'NaN'::float8 THEN 0 ELSE LEAST(90000000000000, GREATEST(0, planned)) END;
--> statement-breakpoint
UPDATE "monthly_paydown" SET planned = CASE WHEN planned = 'NaN'::float8 THEN 0 ELSE LEAST(90000000000000, GREATEST(0, planned)) END;
--> statement-breakpoint
UPDATE "goals" SET
  target = CASE WHEN target = 'NaN'::float8 OR target <= 0 THEN 0.01 ELSE LEAST(90000000000000, target) END,
  starting_value = CASE WHEN starting_value = 'NaN'::float8 THEN 0 ELSE LEAST(90000000000000, GREATEST(0, starting_value)) END;
--> statement-breakpoint
UPDATE "account_balance_snapshots" SET balance = CASE WHEN balance = 'NaN'::float8 THEN 0 ELSE LEAST(90000000000000, GREATEST(-90000000000000, balance)) END;
--> statement-breakpoint

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_balance_range" CHECK (balance <> 'NaN'::float8 AND balance BETWEEN -90000000000000 AND 90000000000000);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_interest_rate_range" CHECK (interest_rate <> 'NaN'::float8 AND interest_rate BETWEEN 0 AND 1);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_min_payment_range" CHECK (min_payment <> 'NaN'::float8 AND min_payment BETWEEN 0 AND 90000000000000);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_planned_payment_range" CHECK (planned_payment <> 'NaN'::float8 AND planned_payment BETWEEN 0 AND 90000000000000);
--> statement-breakpoint
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_planned_range" CHECK (planned <> 'NaN'::float8 AND planned BETWEEN 0 AND 90000000000000);
--> statement-breakpoint
ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_planned_range" CHECK (planned <> 'NaN'::float8 AND planned BETWEEN 0 AND 90000000000000);
--> statement-breakpoint
ALTER TABLE "monthly_paydown" ADD CONSTRAINT "monthly_paydown_planned_range" CHECK (planned <> 'NaN'::float8 AND planned BETWEEN 0 AND 90000000000000);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_target_range" CHECK (target <> 'NaN'::float8 AND target > 0 AND target <= 90000000000000);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_starting_value_range" CHECK (starting_value <> 'NaN'::float8 AND starting_value BETWEEN 0 AND 90000000000000);
--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_balance_range" CHECK (balance <> 'NaN'::float8 AND balance BETWEEN -90000000000000 AND 90000000000000);
--> statement-breakpoint

-- Archive malformed legacy labels, then enforce validated format constraints.
INSERT INTO "migration_0020_data_archive" (source_table, reason, row_data)
SELECT 'monthly_budgets', 'invalid year_month', to_jsonb(mb)
FROM "monthly_budgets" mb
WHERE year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$';
--> statement-breakpoint
DELETE FROM "monthly_budgets" WHERE year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$';
--> statement-breakpoint
INSERT INTO "migration_0020_data_archive" (source_table, reason, row_data)
SELECT 'monthly_paydown', 'invalid year_month', to_jsonb(mp)
FROM "monthly_paydown" mp
WHERE year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$';
--> statement-breakpoint
DELETE FROM "monthly_paydown" WHERE year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$';
--> statement-breakpoint
INSERT INTO "migration_0020_data_archive" (source_table, reason, row_data)
SELECT 'monthly_paydown_snapshots', 'invalid year_month or row_count', to_jsonb(mps)
FROM "monthly_paydown_snapshots" mps
WHERE year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR row_count < 0;
--> statement-breakpoint
DELETE FROM "monthly_paydown_snapshots"
WHERE year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR row_count < 0;
--> statement-breakpoint
INSERT INTO "migration_0020_data_archive" (source_table, reason, row_data)
SELECT 'account_balance_snapshots', 'invalid snapshot_date', to_jsonb(snap)
FROM "account_balance_snapshots" snap
WHERE snapshot_date !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
--> statement-breakpoint
DELETE FROM "account_balance_snapshots"
WHERE snapshot_date !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
--> statement-breakpoint
ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_year_month_format"
  CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint
ALTER TABLE "monthly_paydown" ADD CONSTRAINT "monthly_paydown_year_month_format"
  CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint
ALTER TABLE "monthly_paydown_snapshots" ADD CONSTRAINT "monthly_paydown_snapshots_year_month_format"
  CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint
ALTER TABLE "monthly_paydown_snapshots" ADD CONSTRAINT "monthly_paydown_snapshots_row_count_range"
  CHECK (row_count >= 0);
--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_date_format"
  CHECK (snapshot_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$');
