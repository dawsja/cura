ALTER TABLE "accounts" ADD COLUMN "interest_rate" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "min_payment" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "planned_payment" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "include_in_paydown" boolean DEFAULT true NOT NULL;