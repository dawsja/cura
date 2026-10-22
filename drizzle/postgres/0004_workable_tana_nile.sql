CREATE TABLE IF NOT EXISTS "goal_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"amount" double precision NOT NULL,
	"date" date NOT NULL,
	"exclude_from_budget" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "goal_type" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "spending_reduces_progress" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "use_entire_balance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "annual_growth_rate" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "is_archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_goal_allocations_user" ON "goal_allocations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_goal_allocations_goal" ON "goal_allocations" USING btree ("goal_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_goal_allocations_id" ON "goal_allocations" USING btree ("id");