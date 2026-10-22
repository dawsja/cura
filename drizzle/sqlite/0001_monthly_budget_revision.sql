-- monthly_budgets.revision is the optimistic-concurrency token behind
-- "apply to future months": any change to a row must give it a new value.
CREATE TRIGGER `monthly_budgets_new_revision`
AFTER UPDATE ON `monthly_budgets`
FOR EACH ROW WHEN NEW.`revision` = OLD.`revision`
BEGIN
  UPDATE `monthly_budgets`
  SET `revision` = lower(hex(randomblob(8)))
  WHERE `user_id` = NEW.`user_id`
    AND `sub_category_id` = NEW.`sub_category_id`
    AND `year_month` = NEW.`year_month`;
END;
