-- 0018 was timestamped before 0017, so existing databases skipped it.
-- Repeat the enum addition in a correctly ordered, idempotent migration.
ALTER TYPE "account_type" ADD VALUE IF NOT EXISTS 'uncategorized';
