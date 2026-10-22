-- Categorization rules — user-defined "always set this merchant to this
-- category/sub-category" mappings. Applied at import time (SimpleFIN
-- import + manual add via /api/transactions) and consulted by the
-- Transactions page to decide whether to show the "Create rule?" prompt
-- after an inline category change.
--
-- `match_type` is `'exact'` for now (case-insensitive match via LOWER()
-- on both sides at read time). The column exists so a future migration
-- can add `'contains'` / `'regex'` without a schema change.
--
-- `match_value` stores the merchant string verbatim — preserving the
-- user's chosen capitalisation for display on the Rules page.
--
-- No FK on `user_id` because (a) `user` is owned by Better Auth's
-- schema and we don't reference it elsewhere in our tables, and (b)
-- `deleteUserWithData` in src/db/queries.ts handles cleanup explicitly.
CREATE TABLE "rules" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "match_type" text DEFAULT 'exact' NOT NULL,
  "match_value" text NOT NULL,
  "category" text NOT NULL,
  "sub_category" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "idx_rules_user_merchant" ON "rules" USING btree ("user_id","match_value");
