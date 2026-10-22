-- Preserve every SimpleFIN account even when its type cannot be inferred.
-- Users classify these accounts from the Accounts page after import.
ALTER TYPE "account_type" ADD VALUE IF NOT EXISTS 'uncategorized';
