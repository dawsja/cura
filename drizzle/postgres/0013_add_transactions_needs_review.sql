-- needs_review: per-transaction flag for the bell + carousel review flow.
--
-- TRUE means "this SimpleFIN-imported transaction is sitting in the
-- user's queue awaiting acknowledgement". Set to TRUE on insert by
-- addTransactionWithExternalId (the only SimpleFIN path). Manual
-- transactions default to FALSE because the user typed them in and
-- chose the category themselves.
--
-- Cleared on review (Skip or Categorize). Cleared via the same
-- /api/transactions/:id/review endpoint.
--
-- Boolean DEFAULT FALSE means existing rows (pre-migration) start
-- reviewed — no retroactive queue. New SimpleFIN inserts after the
-- migration will be flagged.
--
-- The compound index supports both the badge count query
-- (WHERE user_id = ? AND needs_review = TRUE) and the queue list
-- query (same WHERE, ordered by date DESC, id DESC).
ALTER TABLE "transactions" ADD COLUMN "needs_review" boolean NOT NULL DEFAULT false;
CREATE INDEX "idx_transactions_user_needs_review"
  ON "transactions" ("user_id", "needs_review");
