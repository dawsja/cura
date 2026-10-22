CREATE TABLE "transaction_splits" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"category" text NOT NULL,
	"sub_category" text NOT NULL,
	"type" "transaction_type" NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_splits_transaction_order_unique" UNIQUE("user_id","transaction_id","sort_order"),
	CONSTRAINT "transaction_splits_amount_cents_positive_safe_integer" CHECK ("transaction_splits"."amount_cents" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "transaction_splits_sort_order_non_negative" CHECK ("transaction_splits"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_balance_range";--> statement-breakpoint
UPDATE "accounts" SET "balance" = ABS("balance") WHERE "balance" < 0;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_id_unique" UNIQUE("user_id","id");--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_user_transaction_fk" FOREIGN KEY ("user_id","transaction_id") REFERENCES "public"."transactions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_transaction_splits_user" ON "transaction_splits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_splits_transaction" ON "transaction_splits" USING btree ("user_id","transaction_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_balance_range" CHECK ("accounts"."balance" BETWEEN 0 AND 90000000000000);
