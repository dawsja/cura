DROP INDEX "idx_rules_user_normalized_merchant";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_category" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_sub_category" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_type" "transaction_type";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_classification_trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "transactions"
SET
	"source_category" = "category",
	"source_sub_category" = "sub_category",
	"source_type" = "type";--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "source_category" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "source_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "source_classification_trusted" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "normalized_match_value" text GENERATED ALWAYS AS (lower(regexp_replace(btrim("match_value"), '\s+', ' ', 'g'))) STORED;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "source_type" "transaction_type";--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "source_category" text;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "source_sub_category" text;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "rules" r
SET "type" = c."type"
FROM "categories" c
WHERE r."type" IS NULL
	AND r."category" <> 'Pay down goals'
	AND c."user_id" = r."user_id"
	AND c."name" = r."category";--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_user_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."accounts"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_rules_user_account" ON "rules" USING btree ("user_id","account_id");--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_user_normalized_scope_unique" UNIQUE NULLS NOT DISTINCT("user_id","normalized_match_value","account_id","source_type","source_category","source_sub_category");
