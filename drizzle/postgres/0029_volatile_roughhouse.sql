ALTER TABLE "transactions" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "sub_category_id" text;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD COLUMN "sub_category_id" text;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "sub_category_id" text;--> statement-breakpoint
WITH "resolved" AS (
	SELECT "t"."id", min("c"."id") AS "category_id", min("s"."id") AS "sub_category_id"
	FROM "transactions" "t"
	JOIN "categories" "c" ON "c"."user_id" = "t"."user_id" AND "c"."name" = "t"."category"
	JOIN "sub_categories" "s" ON "s"."user_id" = "t"."user_id" AND "s"."main_category_id" = "c"."id" AND "s"."name" = "t"."sub_category"
	GROUP BY "t"."id"
	HAVING count(*) = 1
)
UPDATE "transactions" "t" SET "category_id" = "r"."category_id", "sub_category_id" = "r"."sub_category_id"
FROM "resolved" "r" WHERE "t"."id" = "r"."id";--> statement-breakpoint
WITH "resolved" AS (
	SELECT "t"."id", min("c"."id") AS "category_id", min("s"."id") AS "sub_category_id"
	FROM "transaction_splits" "t"
	JOIN "categories" "c" ON "c"."user_id" = "t"."user_id" AND "c"."name" = "t"."category"
	JOIN "sub_categories" "s" ON "s"."user_id" = "t"."user_id" AND "s"."main_category_id" = "c"."id" AND "s"."name" = "t"."sub_category"
	GROUP BY "t"."id"
	HAVING count(*) = 1
)
UPDATE "transaction_splits" "t" SET "category_id" = "r"."category_id", "sub_category_id" = "r"."sub_category_id"
FROM "resolved" "r" WHERE "t"."id" = "r"."id";--> statement-breakpoint
WITH "resolved" AS (
	SELECT "t"."id", min("c"."id") AS "category_id", min("s"."id") AS "sub_category_id"
	FROM "rules" "t"
	JOIN "categories" "c" ON "c"."user_id" = "t"."user_id" AND "c"."name" = "t"."category"
	JOIN "sub_categories" "s" ON "s"."user_id" = "t"."user_id" AND "s"."main_category_id" = "c"."id" AND "s"."name" = "t"."sub_category"
	GROUP BY "t"."id"
	HAVING count(*) = 1
)
UPDATE "rules" "t" SET "category_id" = "r"."category_id", "sub_category_id" = "r"."sub_category_id"
FROM "resolved" "r" WHERE "t"."id" = "r"."id";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_category_fk" FOREIGN KEY ("user_id","category_id") REFERENCES "public"."categories"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_sub_category_fk" FOREIGN KEY ("user_id","sub_category_id") REFERENCES "public"."sub_categories"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_user_category_fk" FOREIGN KEY ("user_id","category_id") REFERENCES "public"."categories"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_user_sub_category_fk" FOREIGN KEY ("user_id","sub_category_id") REFERENCES "public"."sub_categories"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_user_category_fk" FOREIGN KEY ("user_id","category_id") REFERENCES "public"."categories"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_user_sub_category_fk" FOREIGN KEY ("user_id","sub_category_id") REFERENCES "public"."sub_categories"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_transactions_user_category_assignment" ON "transactions" USING btree ("user_id","category_id","sub_category_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_splits_user_category_assignment" ON "transaction_splits" USING btree ("user_id","category_id","sub_category_id");--> statement-breakpoint
CREATE INDEX "idx_rules_user_category_assignment" ON "rules" USING btree ("user_id","category_id","sub_category_id");
