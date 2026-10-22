-- Preserve every financial row whose owner no longer exists before enforcing
-- ownership. This table intentionally has no FK so its forensic records survive.
CREATE TABLE "user_ownership_orphan_archive" (
	"archive_id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"source_table" text NOT NULL,
	"source_user_id" text NOT NULL,
	"row_data" jsonb NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE
	source_table text;
	archived_count bigint := 0;
	deleted_count bigint := 0;
	row_count bigint;
BEGIN
	-- Keep the orphan set stable while it is archived and removed. Reads remain
	-- available, but financial writes and user deletion wait for the migration.
	LOCK TABLE
		"user",
		"accounts",
		"categories",
		"sub_categories",
		"transactions",
		"monthly_budgets",
		"monthly_paydown",
		"monthly_paydown_snapshots",
		"settings",
		"goals",
		"rules",
		"account_balance_snapshots"
	IN SHARE ROW EXCLUSIVE MODE;

	FOREACH source_table IN ARRAY ARRAY[
		'accounts',
		'categories',
		'sub_categories',
		'transactions',
		'monthly_budgets',
		'monthly_paydown',
		'monthly_paydown_snapshots',
		'settings',
		'goals',
		'rules',
		'account_balance_snapshots'
	] LOOP
		EXECUTE format(
			'INSERT INTO "user_ownership_orphan_archive" ("source_table", "source_user_id", "row_data")
			 SELECT %L, orphan_row.user_id, to_jsonb(orphan_row)
			 FROM %I orphan_row
			 WHERE NOT EXISTS (SELECT 1 FROM "user" owner WHERE owner.id = orphan_row.user_id)',
			source_table,
			source_table
		);
		GET DIAGNOSTICS row_count = ROW_COUNT;
		archived_count := archived_count + row_count;
	END LOOP;

	-- Delete children before parents to satisfy the existing tenant-scoped FKs.
	FOREACH source_table IN ARRAY ARRAY[
		'transactions',
		'monthly_budgets',
		'monthly_paydown',
		'monthly_paydown_snapshots',
		'account_balance_snapshots',
		'goals',
		'rules',
		'settings',
		'sub_categories',
		'categories',
		'accounts'
	] LOOP
		EXECUTE format(
			'DELETE FROM %I orphan_row
			 WHERE NOT EXISTS (SELECT 1 FROM "user" owner WHERE owner.id = orphan_row.user_id)',
			source_table
		);
		GET DIAGNOSTICS row_count = ROW_COUNT;
		deleted_count := deleted_count + row_count;
	END LOOP;

	IF archived_count <> deleted_count THEN
		RAISE EXCEPTION 'orphan archival mismatch: archived %, deleted %', archived_count, deleted_count;
	END IF;
	RAISE NOTICE 'archived and removed % orphaned financial rows', archived_count;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monthly_paydown" ADD CONSTRAINT "monthly_paydown_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monthly_paydown_snapshots" ADD CONSTRAINT "monthly_paydown_snapshots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rules" ADD CONSTRAINT "rules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
