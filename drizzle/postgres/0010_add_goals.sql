-- Savings goals — "save up for X" targets watched against a single
-- account. Each row carries the user's target amount, starting value,
-- and the account whose `balance` drives the live progress bar.
--
-- We intentionally do NOT snapshot the account balance on this row —
-- the `accounts.balance` column is the source of truth for the live
-- figure. `starting_value` is just the user's own anchor at goal
-- creation ("I started with $X") so they can read off the progress
-- text without us having to compute anything.
--
-- `account_id` is NOT a foreign key on purpose: accounts can be hidden
-- or deleted, and we want the goal to survive (the user can re-attach
-- a different account via edit). NULL means "the watched account was
-- removed" — the UI renders that as a notice instead of a progress bar.
CREATE TABLE "goals" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "target" double precision NOT NULL,
  "starting_value" double precision DEFAULT 0 NOT NULL,
  "account_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "idx_goals_user" ON "goals" USING btree ("user_id");