-- Add sort_order for drag-to-reorder of main categories on the
-- Categories page. The new column is read by getAllCategories and
-- respected by the Budget page (which renders the same list).
ALTER TABLE "categories" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill existing rows so the order is deterministic from day 1.
-- Oldest category first (sort_order = 0), newest last. New rows added
-- after the migration get max+1 from the application layer.
WITH ordered AS (
  SELECT id, (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at ASC)) - 1 AS new_order
  FROM categories
)
UPDATE categories
SET sort_order = ordered.new_order
FROM ordered
WHERE categories.id = ordered.id;
