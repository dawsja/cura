CREATE TABLE IF NOT EXISTS "forecast_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"date" varchar(10) NOT NULL,
	"amount" double precision NOT NULL,
	"type" varchar(16) NOT NULL,
	"icon" text,
	"color" varchar(16),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_forecast_events_user" ON "forecast_events" USING btree ("user_id");