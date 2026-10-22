CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`role` text,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`institution` text,
	`interest_rate` real DEFAULT 0 NOT NULL,
	`min_payment` integer DEFAULT 0 NOT NULL,
	`planned_payment` integer DEFAULT 0 NOT NULL,
	`include_in_paydown` integer DEFAULT true NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`alias` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "accounts_balance_range" CHECK("accounts"."balance" BETWEEN 0 AND 9000000000000000),
	CONSTRAINT "accounts_interest_rate_range" CHECK("accounts"."interest_rate" BETWEEN 0 AND 1),
	CONSTRAINT "accounts_min_payment_range" CHECK("accounts"."min_payment" BETWEEN 0 AND 9000000000000000),
	CONSTRAINT "accounts_planned_payment_range" CHECK("accounts"."planned_payment" BETWEEN 0 AND 9000000000000000)
);
--> statement-breakpoint
CREATE INDEX `idx_accounts_user` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_id_id_unique` ON `accounts` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`icon` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_categories_user` ON `categories` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_id_id_unique` ON `categories` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `sub_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`main_category_id` text NOT NULL,
	`name` text NOT NULL,
	`planned` integer DEFAULT 0 NOT NULL,
	`icon` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`main_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`main_category_id`) REFERENCES `categories`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sub_categories_planned_range" CHECK("sub_categories"."planned" BETWEEN 0 AND 9000000000000000)
);
--> statement-breakpoint
CREATE INDEX `idx_sub_categories_user` ON `sub_categories` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sub_categories_main` ON `sub_categories` (`main_category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sub_categories_user_id_id_unique` ON `sub_categories` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`source_date` text,
	`date_user_modified` integer DEFAULT false NOT NULL,
	`merchant` text NOT NULL,
	`merchant_user_modified` integer DEFAULT false NOT NULL,
	`source_category` text NOT NULL,
	`source_sub_category` text,
	`source_type` text NOT NULL,
	`source_classification_trusted` integer DEFAULT true NOT NULL,
	`category` text NOT NULL,
	`sub_category` text,
	`category_id` text,
	`sub_category_id` text,
	`category_user_modified` integer DEFAULT false NOT NULL,
	`account_id` text,
	`account` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`type` text NOT NULL,
	`notes` text,
	`external_id` text,
	`source_pending` integer,
	`source_transacted_at` integer,
	`source_last_seen_at` integer,
	`needs_review` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`category_id`) REFERENCES `categories`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`sub_category_id`) REFERENCES `sub_categories`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_amount_cents_safe_integer" CHECK("transactions"."amount_cents" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `idx_transactions_user` ON `transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_date` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `idx_transactions_user_date` ON `transactions` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_transactions_user_category_assignment` ON `transactions` (`user_id`,`category_id`,`sub_category_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_user_account` ON `transactions` (`user_id`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transactions_user_external` ON `transactions` (`user_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_user_needs_review` ON `transactions` (`user_id`,`needs_review`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_user_id_id_unique` ON `transactions` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`category` text NOT NULL,
	`sub_category` text NOT NULL,
	`category_id` text,
	`sub_category_id` text,
	`type` text NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`transaction_id`) REFERENCES `transactions`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`category_id`) REFERENCES `categories`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`sub_category_id`) REFERENCES `sub_categories`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transaction_splits_amount_cents_positive_safe_integer" CHECK("transaction_splits"."amount_cents" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "transaction_splits_sort_order_non_negative" CHECK("transaction_splits"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_transaction_splits_user` ON `transaction_splits` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_transaction_splits_transaction` ON `transaction_splits` (`user_id`,`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_transaction_splits_user_category_assignment` ON `transaction_splits` (`user_id`,`category_id`,`sub_category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_splits_transaction_order_unique` ON `transaction_splits` (`user_id`,`transaction_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `simplefin_transaction_aliases` (
	`user_id` text NOT NULL,
	`external_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `external_id`),
	FOREIGN KEY (`user_id`,`transaction_id`) REFERENCES `transactions`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_simplefin_transaction_aliases_transaction` ON `simplefin_transaction_aliases` (`user_id`,`transaction_id`);--> statement-breakpoint
CREATE TABLE `simplefin_ignored_transactions` (
	`user_id` text NOT NULL,
	`external_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `external_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `monthly_budgets` (
	`user_id` text NOT NULL,
	`sub_category_id` text NOT NULL,
	`year_month` text NOT NULL,
	`planned` integer NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`revision` text DEFAULT (lower(hex(randomblob(8)))) NOT NULL,
	PRIMARY KEY(`user_id`, `sub_category_id`, `year_month`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`sub_category_id`) REFERENCES `sub_categories`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "monthly_budgets_year_month_format" CHECK("monthly_budgets"."year_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr("monthly_budgets"."year_month", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "monthly_budgets_planned_range" CHECK("monthly_budgets"."planned" BETWEEN 0 AND 9000000000000000)
);
--> statement-breakpoint
CREATE INDEX `idx_monthly_budgets_year_month` ON `monthly_budgets` (`year_month`);--> statement-breakpoint
CREATE TABLE `settings` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oidc_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`discovery_url` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`scopes` text DEFAULT '["openid","email","profile"]' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_providers_provider_id_unique` ON `oidc_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_oidc_providers_provider` ON `oidc_providers` (`provider_id`);--> statement-breakpoint
CREATE TABLE `setup_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`needs_admin` integer DEFAULT true NOT NULL,
	`oidc_configured` integer DEFAULT false NOT NULL,
	`bootstrap_completed` integer DEFAULT false NOT NULL,
	`bootstrap_token_hash` text,
	`bootstrap_token_expires_at` integer,
	`local_auth_disabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`target` integer NOT NULL,
	`starting_value` integer DEFAULT 0 NOT NULL,
	`account_id` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`account_id`) REFERENCES `accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "goals_target_range" CHECK("goals"."target" > 0 AND "goals"."target" <= 9000000000000000),
	CONSTRAINT "goals_starting_value_range" CHECK("goals"."starting_value" BETWEEN 0 AND 9000000000000000)
);
--> statement-breakpoint
CREATE INDEX `idx_goals_user` ON `goals` (`user_id`);--> statement-breakpoint
CREATE TABLE `monthly_paydown` (
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`year_month` text NOT NULL,
	`planned` integer NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `account_id`, `year_month`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "monthly_paydown_year_month_format" CHECK("monthly_paydown"."year_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr("monthly_paydown"."year_month", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "monthly_paydown_planned_range" CHECK("monthly_paydown"."planned" BETWEEN 0 AND 9000000000000000)
);
--> statement-breakpoint
CREATE INDEX `idx_monthly_paydown_user` ON `monthly_paydown` (`user_id`);--> statement-breakpoint
CREATE TABLE `monthly_paydown_snapshots` (
	`user_id` text NOT NULL,
	`year_month` text NOT NULL,
	`synced_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`row_count` integer NOT NULL,
	PRIMARY KEY(`user_id`, `year_month`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "monthly_paydown_snapshots_year_month_format" CHECK("monthly_paydown_snapshots"."year_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr("monthly_paydown_snapshots"."year_month", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "monthly_paydown_snapshots_row_count_range" CHECK("monthly_paydown_snapshots"."row_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_monthly_paydown_snapshots_user` ON `monthly_paydown_snapshots` (`user_id`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`match_type` text DEFAULT 'exact' NOT NULL,
	`match_value` text NOT NULL,
	`normalized_match_value` text GENERATED ALWAYS AS (lower(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace("match_value", char(9), ' '), char(10), ' '), char(13), ' '), char(12), ' '), char(11), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')))) VIRTUAL,
	`account_id` text,
	`source_type` text,
	`source_category` text,
	`source_sub_category` text,
	`category` text NOT NULL,
	`sub_category` text,
	`category_id` text,
	`sub_category_id` text,
	`type` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`account_id`) REFERENCES `accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`category_id`) REFERENCES `categories`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`sub_category_id`) REFERENCES `sub_categories`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_rules_user_merchant` ON `rules` (`user_id`,`match_value`);--> statement-breakpoint
CREATE INDEX `idx_rules_user_account` ON `rules` (`user_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `idx_rules_user_category_assignment` ON `rules` (`user_id`,`category_id`,`sub_category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `rules_user_normalized_scope_unique` ON `rules` (`user_id`,`normalized_match_value`,coalesce(`account_id`, ''),coalesce(`source_type`, ''),coalesce(`source_category`, ''),coalesce(`source_sub_category`, ''));--> statement-breakpoint
CREATE TABLE `mcp_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_access_tokens_token_hash_unique` ON `mcp_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_mcp_access_tokens_user` ON `mcp_access_tokens` (`user_id`);