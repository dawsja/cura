CREATE TABLE IF NOT EXISTS "spending_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"year_month" text NOT NULL,
	"main_category_id" text NOT NULL,
	"main_category_name" text NOT NULL,
	"planned" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "forecast_events" CASCADE;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_spending_plans_user" ON "spending_plans" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_spending_plans_user_month_cat" ON "spending_plans" USING btree ("user_id","year_month","main_category_id");