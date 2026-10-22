DO $emoji_defaults$
DECLARE
  default_sub RECORD;
BEGIN
  FOR default_sub IN
    SELECT * FROM (VALUES
      ('Income', 'sub-paychecks', 'Paychecks', '💵 Paychecks'),
      ('Income', 'sub-interest', 'Interest', '🏦 Interest'),
      ('Income', 'sub-business-income', 'Business Income', '💼 Business Income'),
      ('Income', 'sub-other-income', 'Other Income', '💰 Other Income'),
      ('Gifts & Donations', 'sub-charity', 'Charity', '❤️ Charity'),
      ('Gifts & Donations', 'sub-gifts', 'Gifts', '🎁 Gifts'),
      ('Auto & Transport', 'sub-auto-payment', 'Auto Payment', '🚘 Auto Payment'),
      ('Auto & Transport', 'sub-public-transit', 'Public Transit', '🚌 Public Transit'),
      ('Auto & Transport', 'sub-gas-fuel', 'Gas', '⛽ Gas'),
      ('Auto & Transport', 'sub-auto-maintenance', 'Auto Maintenance', '🔧 Auto Maintenance'),
      ('Auto & Transport', 'sub-parking-tolls', 'Parking & Tolls', '🅿️ Parking & Tolls'),
      ('Auto & Transport', 'sub-taxi-rideshares', 'Taxi & Ride Shares', '🚕 Taxi & Ride Shares'),
      ('Housing', 'sub-mortgage', 'Mortgage', '🏦 Mortgage'),
      ('Housing', 'sub-rent', 'Rent', '🔑 Rent'),
      ('Housing', 'sub-home-improvement', 'Home Improvement', '🛠️ Home Improvement'),
      ('Bills & Utilities', 'sub-garbage', 'Garbage', '🗑️ Garbage'),
      ('Bills & Utilities', 'sub-water', 'Water', '💧 Water'),
      ('Bills & Utilities', 'sub-gas-electric', 'Gas & Electric', '⚡ Gas & Electric'),
      ('Bills & Utilities', 'sub-internet-cable', 'Internet & Cable', '🌐 Internet & Cable'),
      ('Bills & Utilities', 'sub-phone', 'Phone', '📱 Phone'),
      ('Food & Dining', 'sub-groceries', 'Groceries', '🛒 Groceries'),
      ('Food & Dining', 'sub-restaurants-bars', 'Restaurants & Bars', '🍻 Restaurants & Bars'),
      ('Food & Dining', 'sub-coffee-shops', 'Coffee Shops', '☕ Coffee Shops'),
      ('Travel & Lifestyle', 'sub-travel-vacation', 'Travel & Vacation', '🏖️ Travel & Vacation'),
      ('Travel & Lifestyle', 'sub-entertainment', 'Entertainment & Recreation', '🎮 Entertainment & Recreation'),
      ('Travel & Lifestyle', 'sub-personal', 'Personal', '🧴 Personal'),
      ('Travel & Lifestyle', 'sub-pets', 'Pets', '🐾 Pets'),
      ('Travel & Lifestyle', 'sub-fun-money', 'Fun Money', '🎉 Fun Money'),
      ('Shopping', 'sub-shopping', 'Shopping', '🛍️ Shopping'),
      ('Shopping', 'sub-clothing', 'Clothing', '👕 Clothing'),
      ('Shopping', 'sub-furniture-housewares', 'Furniture & Housewares', '🛋️ Furniture & Housewares'),
      ('Shopping', 'sub-electronics', 'Electronics', '💻 Electronics'),
      ('Children', 'sub-child-care', 'Child Care', '🧸 Child Care'),
      ('Children', 'sub-child-activities', 'Child Activities', '⚽ Child Activities'),
      ('Education', 'sub-student-loans', 'Student Loans', '🎓 Student Loans'),
      ('Education', 'sub-education', 'Education', '📚 Education'),
      ('Health & Wellness', 'sub-medical', 'Medical', '🩺 Medical'),
      ('Health & Wellness', 'sub-dentist', 'Dentist', '🦷 Dentist'),
      ('Health & Wellness', 'sub-fitness', 'Fitness', '🏋️ Fitness'),
      ('Financial', 'sub-loan-repayment', 'Loan Repayment', '💸 Loan Repayment'),
      ('Financial', 'sub-financial-legal', 'Financial & Legal Services', '⚖️ Financial & Legal Services'),
      ('Financial', 'sub-financial-fees', 'Financial Fees', '🧾 Financial Fees'),
      ('Financial', 'sub-cash-atm', 'Cash & ATM', '🏧 Cash & ATM'),
      ('Financial', 'sub-insurance', 'Insurance', '🛡️ Insurance'),
      ('Financial', 'sub-taxes', 'Taxes', '🧾 Taxes'),
      ('Other', 'sub-uncategorized', 'Uncategorized', '❓ Uncategorized'),
      ('Other', 'sub-check', 'Check', '✍️ Check'),
      ('Other', 'sub-miscellaneous', 'Miscellaneous', '📦 Miscellaneous'),
      ('Business', 'sub-advertising-promotion', 'Advertising & Promotion', '📣 Advertising & Promotion'),
      ('Business', 'sub-business-utilities', 'Business Utilities & Communication', '📡 Business Utilities & Communication'),
      ('Business', 'sub-employee-wages', 'Employee Wages & Contract Labor', '👷 Employee Wages & Contract Labor'),
      ('Business', 'sub-business-travel', 'Business Travel & Meals', '✈️ Business Travel & Meals'),
      ('Business', 'sub-business-auto', 'Business Auto Expenses', '🚗 Business Auto Expenses'),
      ('Business', 'sub-business-insurance', 'Business Insurance', '🛡️ Business Insurance'),
      ('Business', 'sub-office-supplies', 'Office Supplies & Expenses', '📎 Office Supplies & Expenses'),
      ('Business', 'sub-office-rent', 'Office Rent', '🏢 Office Rent'),
      ('Business', 'sub-postage-shipping', 'Postage & Shipping', '📮 Postage & Shipping'),
      ('Transfer', 'sub-account-transfer', 'Account Transfer', '🔄 Account Transfer'),
      ('Transfer', 'sub-credit-card-payment', 'Credit Card Payment', '💳 Credit Card Payment'),
      ('Transfer', 'sub-balance-adjustments', 'Balance Adjustments', '⚖️ Balance Adjustments')
    ) AS defaults(parent_name, stable_id, old_name, new_name)
  LOOP
    UPDATE transactions t
       SET sub_category = default_sub.new_name
     WHERE t.sub_category_id IN (
       SELECT s.id
         FROM sub_categories s
        WHERE s.id = s.user_id || '__' || default_sub.stable_id
          AND s.name = default_sub.old_name
     );

    UPDATE transaction_splits ts
       SET sub_category = default_sub.new_name
     WHERE ts.sub_category_id IN (
       SELECT s.id
         FROM sub_categories s
        WHERE s.id = s.user_id || '__' || default_sub.stable_id
          AND s.name = default_sub.old_name
     );

    UPDATE rules r
       SET sub_category = default_sub.new_name,
           updated_at = now(),
           version = r.version + 1
     WHERE r.sub_category_id IN (
       SELECT s.id
         FROM sub_categories s
        WHERE s.id = s.user_id || '__' || default_sub.stable_id
          AND s.name = default_sub.old_name
     );

    UPDATE transactions
       SET source_sub_category = default_sub.new_name
     WHERE source_category = default_sub.parent_name
       AND source_sub_category = default_sub.old_name;

    UPDATE rules
       SET source_sub_category = default_sub.new_name,
           updated_at = now(),
           version = version + 1
     WHERE source_category = default_sub.parent_name
       AND source_sub_category = default_sub.old_name;

    UPDATE sub_categories s
       SET name = default_sub.new_name
     WHERE s.id = s.user_id || '__' || default_sub.stable_id
       AND s.name = default_sub.old_name;
  END LOOP;
END $emoji_defaults$;
