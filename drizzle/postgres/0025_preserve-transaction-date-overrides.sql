ALTER TABLE "transactions" ADD COLUMN "source_date" date;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "date_user_modified" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Existing imported rows may already contain user-edited posting dates, and
-- historical state does not reveal which ones were changed. Preserve every
-- current imported date. The next sync records SimpleFIN's date separately;
-- users can subsequently reset an override by choosing that source date.
UPDATE "transactions"
SET "source_date" = "date", "date_user_modified" = true
WHERE "external_id" IS NOT NULL;
