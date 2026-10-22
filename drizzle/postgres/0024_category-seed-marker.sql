-- Every user present at upgrade time has already passed initial onboarding.
-- Mark them seeded without changing their current category tree, including
-- defaults they intentionally deleted.
INSERT INTO "settings" ("user_id", "key", "value", "updated_at")
SELECT "id", 'initial_categories_seeded', 'true', now()
FROM "user"
ON CONFLICT ("user_id", "key") DO NOTHING;
