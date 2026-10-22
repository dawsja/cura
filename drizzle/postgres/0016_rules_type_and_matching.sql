-- Rules gain an optional transaction `type` so a user correction like
-- transfer → expense is remembered for future imports of the same
-- merchant. NULL means "don't override type" (category-only rules keep
-- working). Matching itself is application-side (exact + prefix); no
-- schema change needed for that.
ALTER TABLE "rules" ADD COLUMN "type" "transaction_type";
