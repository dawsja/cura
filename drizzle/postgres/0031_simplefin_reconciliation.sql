CREATE TABLE "simplefin_transaction_aliases" (
	"user_id" text NOT NULL,
	"external_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simplefin_transaction_aliases_user_id_external_id_pk" PRIMARY KEY("user_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_pending" boolean;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_transacted_at" bigint;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "simplefin_transaction_aliases" ADD CONSTRAINT "simplefin_transaction_aliases_user_transaction_fk" FOREIGN KEY ("user_id","transaction_id") REFERENCES "public"."transactions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_simplefin_transaction_aliases_transaction" ON "simplefin_transaction_aliases" USING btree ("user_id","transaction_id");
--> statement-breakpoint
UPDATE "transactions"
SET
	"source_pending" = CASE WHEN "notes" = 'Pending Transaction' THEN true ELSE NULL END,
	"source_last_seen_at" = now()
WHERE "external_id" LIKE 'sf-%';
--> statement-breakpoint
INSERT INTO "simplefin_transaction_aliases" ("user_id", "external_id", "transaction_id")
SELECT "user_id", "external_id", "id"
FROM "transactions"
WHERE "external_id" LIKE 'sf-%'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TEMP TABLE "simplefin_repair_candidates" ON COMMIT DROP AS
WITH possible AS (
	SELECT
		pending."user_id",
		pending."id" AS "pending_id",
		posted."id" AS "posted_id",
		posted."external_id" AS "posted_external_id",
		count(*) OVER (PARTITION BY pending."user_id", pending."id") AS "posted_matches",
		count(*) OVER (PARTITION BY posted."user_id", posted."id") AS "pending_matches"
	FROM "transactions" pending
	JOIN "transactions" posted
		ON posted."user_id" = pending."user_id"
		AND posted."id" <> pending."id"
		AND posted."account_id" = pending."account_id"
		AND posted."external_id" LIKE 'sf-%'
		AND posted."notes" IS DISTINCT FROM 'Pending Transaction'
		AND posted."source_type" = pending."source_type"
		AND lower(regexp_replace(btrim(posted."merchant"), '\s+', ' ', 'g'))
			= lower(regexp_replace(btrim(pending."merchant"), '\s+', ' ', 'g'))
		AND posted."amount_cents" >= pending."amount_cents"
		AND posted."amount_cents" * 10 <= pending."amount_cents" * 13
		AND abs(posted."amount_cents" - pending."amount_cents") <= 10000
		AND coalesce(posted."source_date", posted."date")
			BETWEEN coalesce(pending."source_date", pending."date") - 1
			AND coalesce(pending."source_date", pending."date") + 1
		AND posted."created_at" >= pending."created_at"
	WHERE pending."source_pending" = true
		AND pending."source_type" = 'expense'
		AND pending."account_id" IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM "transaction_splits" s
			WHERE s."user_id" = pending."user_id"
				AND s."transaction_id" IN (pending."id", posted."id")
		)
		AND NOT (
			pending."category_user_modified" AND posted."category_user_modified"
			AND (pending."category_id", pending."sub_category_id", pending."type")
				IS DISTINCT FROM (posted."category_id", posted."sub_category_id", posted."type")
		)
		AND NOT (
			pending."date_user_modified" AND pending."date" IS DISTINCT FROM pending."source_date"
			AND posted."date_user_modified" AND posted."date" IS DISTINCT FROM posted."source_date"
			AND pending."date" IS DISTINCT FROM posted."date"
		)
)
SELECT "user_id", "pending_id", "posted_id", "posted_external_id"
FROM possible
WHERE "posted_matches" = 1 AND "pending_matches" = 1;
--> statement-breakpoint
UPDATE "simplefin_transaction_aliases" aliases
SET "transaction_id" = candidates."pending_id", "last_seen_at" = now()
FROM "simplefin_repair_candidates" candidates
WHERE aliases."user_id" = candidates."user_id"
	AND aliases."transaction_id" = candidates."posted_id";
--> statement-breakpoint
UPDATE "transactions" posted
SET "external_id" = NULL
FROM "simplefin_repair_candidates" candidates
WHERE posted."user_id" = candidates."user_id" AND posted."id" = candidates."posted_id";
--> statement-breakpoint
UPDATE "transactions" pending
SET
	"date" = CASE
		WHEN pending."date_user_modified" AND pending."date" IS DISTINCT FROM pending."source_date" THEN pending."date"
		WHEN posted."date_user_modified" AND posted."date" IS DISTINCT FROM posted."source_date" THEN posted."date"
		ELSE posted."date"
	END,
	"source_date" = posted."source_date",
	"date_user_modified" = (pending."date_user_modified" AND pending."date" IS DISTINCT FROM pending."source_date")
		OR (posted."date_user_modified" AND posted."date" IS DISTINCT FROM posted."source_date"),
	"merchant" = posted."merchant",
	"source_category" = posted."source_category",
	"source_sub_category" = posted."source_sub_category",
	"source_type" = posted."source_type",
	"source_classification_trusted" = posted."source_classification_trusted",
	"category" = CASE WHEN posted."category_user_modified" AND NOT pending."category_user_modified" THEN posted."category" ELSE pending."category" END,
	"sub_category" = CASE WHEN posted."category_user_modified" AND NOT pending."category_user_modified" THEN posted."sub_category" ELSE pending."sub_category" END,
	"category_id" = CASE WHEN posted."category_user_modified" AND NOT pending."category_user_modified" THEN posted."category_id" ELSE pending."category_id" END,
	"sub_category_id" = CASE WHEN posted."category_user_modified" AND NOT pending."category_user_modified" THEN posted."sub_category_id" ELSE pending."sub_category_id" END,
	"category_user_modified" = pending."category_user_modified" OR posted."category_user_modified",
	"account_id" = posted."account_id",
	"account" = posted."account",
	"amount_cents" = posted."amount_cents",
	"type" = CASE WHEN posted."category_user_modified" AND NOT pending."category_user_modified" THEN posted."type" ELSE pending."type" END,
	"notes" = CASE WHEN pending."notes" = 'Pending Transaction' THEN posted."notes" ELSE pending."notes" END,
	"external_id" = candidates."posted_external_id",
	"source_pending" = false,
	"source_last_seen_at" = now(),
	"needs_review" = pending."needs_review" AND posted."needs_review"
FROM "simplefin_repair_candidates" candidates
JOIN "transactions" posted
	ON posted."user_id" = candidates."user_id" AND posted."id" = candidates."posted_id"
WHERE pending."user_id" = candidates."user_id" AND pending."id" = candidates."pending_id";
--> statement-breakpoint
DELETE FROM "transactions" posted
USING "simplefin_repair_candidates" candidates
WHERE posted."user_id" = candidates."user_id" AND posted."id" = candidates."posted_id";
