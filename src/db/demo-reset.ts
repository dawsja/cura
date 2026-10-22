import { hashPassword } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';
import { db, sqlAll, sqlRun } from './client';
import {
  account,
  accounts,
  categories,
  goals,
  monthlyBudgets,
  monthlyPaydown,
  monthlyPaydownSnapshots,
  rules,
  settings,
  setupState,
  subCategories,
  transactionSplits,
  transactions,
  user,
} from './schema';
import { INITIAL_CATEGORIES } from './seed';

export const DEMO_EMAIL = 'demo@curamoney.com';
export const DEMO_PASSWORD = 'demo';

const DEMO_USER_ID = 'demo-user';
const MAIN_CATEGORY_EMOJI_PREFIX = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\s]+/u;

function plainMainCategoryName(name: string): string {
  return name.replace(MAIN_CATEGORY_EMOJI_PREFIX, '');
}

function demoAssignment(categoryName: string, subCategoryName: string) {
  const category = INITIAL_CATEGORIES.find((item) => item.name === plainMainCategoryName(categoryName));
  const subCategory = category?.subCategories.find((item) => item.name === subCategoryName);
  return {
    categoryId: category ? `${DEMO_USER_ID}:${category.id}` : null,
    subCategoryId: subCategory ? `${DEMO_USER_ID}:${subCategory.id}` : null,
  };
}

function paydownAssignment(subCategoryName: string) {
  const subCategoryId = subCategoryName === 'Everyday Rewards Card'
    ? `${DEMO_USER_ID}:sub-paydown-credit`
    : subCategoryName === 'Auto Loan'
      ? `${DEMO_USER_ID}:sub-paydown-auto-loan`
      : null;
  return {
    categoryId: `${DEMO_USER_ID}:cat-paydown-goals`,
    subCategoryId,
  };
}

function demoTransactionAssignment(item: DemoTransaction) {
  if (item.category === 'Pay down goals') return paydownAssignment(item.subCategory);
  return demoAssignment(item.category, item.subCategory);
}

function dateAtOffset(dayOffset: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

function monthAtOffset(monthOffset: number): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + monthOffset);
  return date.toISOString().slice(0, 7);
}

interface DemoTransaction {
  id: string;
  dayOffset: number;
  merchant: string;
  category: string;
  subCategory: string;
  accountId: string;
  accountName: string;
  amountCents: number;
  type: 'income' | 'expense' | 'transfer';
  needsReview?: boolean;
  notes?: string;
}

const transactionTemplates = ([
  { id: 'paycheck-1', dayOffset: -2, merchant: 'Acme Design Studio', category: '💰 Income', subCategory: '💵 Paychecks', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 325000, type: 'income' },
  { id: 'groceries-1', dayOffset: -1, merchant: 'Fresh Market', category: '🍽️ Food & Dining', subCategory: '🛒 Groceries', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 8642, type: 'expense' },
  { id: 'coffee-1', dayOffset: -2, merchant: 'Juniper Coffee', category: '🍽️ Food & Dining', subCategory: '☕ Coffee Shops', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 575, type: 'expense' },
  { id: 'fuel-1', dayOffset: -3, merchant: 'Shell', category: '🚗 Auto & Transport', subCategory: '⛽ Gas', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 4821, type: 'expense' },
  { id: 'restaurant-1', dayOffset: -4, merchant: 'Green Table Kitchen', category: '🍽️ Food & Dining', subCategory: '🍻 Restaurants & Bars', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 6730, type: 'expense' },
  { id: 'restaurant-2', dayOffset: -1, merchant: 'Harbor Ramen', category: '🍽️ Food & Dining', subCategory: '🍻 Restaurants & Bars', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 4280, type: 'expense' },
  { id: 'restaurant-3', dayOffset: -2, merchant: 'Copper Oven Pizza', category: '🍽️ Food & Dining', subCategory: '🍻 Restaurants & Bars', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 5875, type: 'expense' },
  { id: 'restaurant-4', dayOffset: -3, merchant: 'Oak & Ember', category: '🍽️ Food & Dining', subCategory: '🍻 Restaurants & Bars', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 3690, type: 'expense' },
  { id: 'restaurant-5', dayOffset: -5, merchant: 'The Corner Bistro', category: '🍽️ Food & Dining', subCategory: '🍻 Restaurants & Bars', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 7425, type: 'expense' },
  { id: 'restaurant-6', dayOffset: -6, merchant: 'Nightjar Bar', category: '🍽️ Food & Dining', subCategory: '🍻 Restaurants & Bars', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 2960, type: 'expense' },
  { id: 'restaurant-7', dayOffset: -8, merchant: 'Sunday Brunch Co.', category: '🍽️ Food & Dining', subCategory: '🍻 Restaurants & Bars', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 5310, type: 'expense' },
  { id: 'internet-1', dayOffset: -5, merchant: 'Metro Fiber', category: '💡 Bills & Utilities', subCategory: '🌐 Internet & Cable', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 7900, type: 'expense' },
  { id: 'review-1', dayOffset: -6, merchant: 'SQ *NORTHSIDE MARKET', category: '📦 Other', subCategory: '❓ Uncategorized', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 2347, type: 'expense', needsReview: true },
  { id: 'review-2', dayOffset: -7, merchant: 'ACH DEBIT 48392', category: '📦 Other', subCategory: '❓ Uncategorized', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 4200, type: 'expense', needsReview: true },
  { id: 'transfer-save', dayOffset: -8, merchant: 'Transfer to Travel Fund', category: '🔄 Transfer', subCategory: '🔄 Account Transfer', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 30000, type: 'transfer' },
  { id: 'gym-1', dayOffset: -9, merchant: 'City Fitness', category: '❤️ Health & Wellness', subCategory: '🏋️ Fitness', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 4500, type: 'expense' },
  { id: 'streaming-1', dayOffset: -28, merchant: 'Streambox', category: '✈️ Travel & Lifestyle', subCategory: '🎮 Entertainment & Recreation', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 1599, type: 'expense' },
  { id: 'password-safe-1', dayOffset: -30, merchant: 'Password Safe', category: '💡 Bills & Utilities', subCategory: '🌐 Internet & Cable', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 3599, type: 'expense' },
  { id: 'weeknight-1', dayOffset: -6, merchant: 'Weeknight Bites', category: '🍽️ Food & Dining', subCategory: '🛒 Groceries', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 4999, type: 'expense' },
  { id: 'weeknight-2', dayOffset: -13, merchant: 'Weeknight Bites', category: '🍽️ Food & Dining', subCategory: '🛒 Groceries', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 4999, type: 'expense' },
  { id: 'weeknight-3', dayOffset: -20, merchant: 'Weeknight Bites', category: '🍽️ Food & Dining', subCategory: '🛒 Groceries', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 4999, type: 'expense' },
  { id: 'weeknight-4', dayOffset: -27, merchant: 'Weeknight Bites', category: '🍽️ Food & Dining', subCategory: '🛒 Groceries', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 4999, type: 'expense' },
  { id: 'weeknight-5', dayOffset: -34, merchant: 'Weeknight Bites', category: '🍽️ Food & Dining', subCategory: '🛒 Groceries', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 4999, type: 'expense' },
  { id: 'rent-1', dayOffset: -12, merchant: 'Oak Street Apartments', category: '🏠 Housing', subCategory: '🔑 Rent', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 165000, type: 'expense' },
  { id: 'electric-1', dayOffset: -14, merchant: 'City Electric', category: '💡 Bills & Utilities', subCategory: '⚡ Gas & Electric', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 11843, type: 'expense' },
  { id: 'card-payment-1', dayOffset: -15, merchant: 'Credit Card Payment', category: '🔄 Transfer', subCategory: '💳 Credit Card Payment', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 65000, type: 'transfer' },
  { id: 'paydown-credit-1', dayOffset: -10, merchant: 'Everyday Rewards Card Payment', category: 'Pay down goals', subCategory: 'Everyday Rewards Card', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 25000, type: 'expense' },
  { id: 'auto-payment-1', dayOffset: -16, merchant: 'Community Auto Finance', category: '🚗 Auto & Transport', subCategory: '🚘 Auto Payment', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 38500, type: 'expense' },
  { id: 'shopping-split', dayOffset: -18, merchant: 'Target', category: '🛍️ Shopping', subCategory: '🛍️ Shopping', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 14238, type: 'expense', notes: 'Household supplies and groceries' },
  { id: 'paycheck-2', dayOffset: -17, merchant: 'Acme Design Studio', category: '💰 Income', subCategory: '💵 Paychecks', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 325000, type: 'income' },
  { id: 'groceries-2', dayOffset: -21, merchant: 'Fresh Market', category: '🍽️ Food & Dining', subCategory: '🛒 Groceries', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 12154, type: 'expense' },
  { id: 'phone-1', dayOffset: -23, merchant: 'Mobile One', category: '💡 Bills & Utilities', subCategory: '📱 Phone', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 6800, type: 'expense' },
  { id: 'insurance-1', dayOffset: -25, merchant: 'Safe Harbor Insurance', category: '💳 Financial', subCategory: '🛡️ Insurance', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 13200, type: 'expense' },
  { id: 'interest-1', dayOffset: -27, merchant: 'Savings Interest', category: '💰 Income', subCategory: '🏦 Interest', accountId: 'demo-emergency', accountName: 'Emergency Savings', amountCents: 1842, type: 'income' },
  { id: 'paycheck-3', dayOffset: -32, merchant: 'Acme Design Studio', category: '💰 Income', subCategory: '💵 Paychecks', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 325000, type: 'income' },
  { id: 'rent-2', dayOffset: -42, merchant: 'Oak Street Apartments', category: '🏠 Housing', subCategory: '🔑 Rent', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 165000, type: 'expense' },
  { id: 'groceries-3', dayOffset: -36, merchant: 'Fresh Market', category: '🍽️ Food & Dining', subCategory: '🛒 Groceries', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 9764, type: 'expense' },
  { id: 'travel-1', dayOffset: -40, merchant: 'Pacific Air', category: '✈️ Travel & Lifestyle', subCategory: '🏖️ Travel & Vacation', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 42800, type: 'expense' },
  { id: 'paycheck-4', dayOffset: -48, merchant: 'Acme Design Studio', category: '💰 Income', subCategory: '💵 Paychecks', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 325000, type: 'income' },
  { id: 'rent-3', dayOffset: -72, merchant: 'Oak Street Apartments', category: '🏠 Housing', subCategory: '🔑 Rent', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 165000, type: 'expense' },
  { id: 'paycheck-5', dayOffset: -63, merchant: 'Acme Design Studio', category: '💰 Income', subCategory: '💵 Paychecks', accountId: 'demo-checking', accountName: 'Everyday Checking', amountCents: 325000, type: 'income' },
  { id: 'groceries-4', dayOffset: -66, merchant: 'Fresh Market', category: '🍽️ Food & Dining', subCategory: '🛒 Groceries', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 10891, type: 'expense' },
  { id: 'streaming-2', dayOffset: -58, merchant: 'Streambox', category: '✈️ Travel & Lifestyle', subCategory: '🎮 Entertainment & Recreation', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 1599, type: 'expense' },
  { id: 'streaming-3', dayOffset: -88, merchant: 'Streambox', category: '✈️ Travel & Lifestyle', subCategory: '🎮 Entertainment & Recreation', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 1599, type: 'expense' },
  { id: 'password-safe-2', dayOffset: -395, merchant: 'Password Safe', category: '💡 Bills & Utilities', subCategory: '🌐 Internet & Cable', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 3599, type: 'expense' },
  { id: 'password-safe-3', dayOffset: -760, merchant: 'Password Safe', category: '💡 Bills & Utilities', subCategory: '🌐 Internet & Cable', accountId: 'demo-credit', accountName: 'Everyday Rewards Card', amountCents: 3599, type: 'expense' },
] satisfies DemoTransaction[]).map((item) => ({ ...item, category: plainMainCategoryName(item.category) }));

export async function resetDemoDatabase(): Promise<{ users: number; transactions: number }> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const now = new Date();
  const currentMonth = monthAtOffset(0);
  const previousMonth = monthAtOffset(-1);

  await db.transaction(async (tx) => {
    // Demo mode owns this database. Include future tables automatically,
    // while leaving Drizzle's migration history intact. Foreign keys are
    // checked at commit, once the fixture is back in place.
    const tables = await sqlAll<{ name: string }>(sql`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'
    `);
    await sqlRun(sql`PRAGMA defer_foreign_keys = ON`);
    for (const { name } of tables) {
      await sqlRun(sql.raw(`DELETE FROM "${name.replaceAll('"', '""')}"`));
    }

    await tx.insert(setupState).values({
      id: 1,
      needsAdmin: false,
      oidcConfigured: false,
      bootstrapCompleted: true,
      localAuthDisabled: false,
    });
    await tx.insert(user).values({
      id: DEMO_USER_ID,
      name: 'Demo User',
      email: DEMO_EMAIL,
      emailVerified: true,
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(account).values({
      id: 'demo-credential',
      accountId: DEMO_USER_ID,
      providerId: 'credential',
      userId: DEMO_USER_ID,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(categories).values(INITIAL_CATEGORIES.map((category, sortOrder) => ({
      id: `${DEMO_USER_ID}:${category.id}`,
      userId: DEMO_USER_ID,
      name: category.name,
      type: category.type,
      sortOrder,
    })));
    await tx.insert(subCategories).values(INITIAL_CATEGORIES.flatMap((category) =>
      category.subCategories.map((subCategory) => ({
        id: `${DEMO_USER_ID}:${subCategory.id}`,
        userId: DEMO_USER_ID,
        mainCategoryId: `${DEMO_USER_ID}:${category.id}`,
        name: subCategory.name,
        planned: subCategory.planned,
      })),
    ));

    const paydownCategoryId = `${DEMO_USER_ID}:cat-paydown-goals`;
    await tx.insert(categories).values({
      id: paydownCategoryId,
      userId: DEMO_USER_ID,
      name: 'Pay down goals',
      type: 'transfer',
      icon: 'CreditCard',
      sortOrder: INITIAL_CATEGORIES.length,
    });
    await tx.insert(subCategories).values([
      { id: `${DEMO_USER_ID}:sub-paydown-credit`, userId: DEMO_USER_ID, mainCategoryId: paydownCategoryId, name: 'Everyday Rewards Card', planned: 0 },
      { id: `${DEMO_USER_ID}:sub-paydown-auto-loan`, userId: DEMO_USER_ID, mainCategoryId: paydownCategoryId, name: 'Auto Loan', planned: 0 },
    ]);

    await tx.insert(accounts).values([
      { id: 'demo-checking', userId: DEMO_USER_ID, name: 'Everyday Checking', type: 'checking', balance: 4250.67, institution: 'Community Bank' },
      { id: 'demo-emergency', userId: DEMO_USER_ID, name: 'Emergency Savings', type: 'savings', balance: 8200, institution: 'Community Bank' },
      { id: 'demo-travel', userId: DEMO_USER_ID, name: 'Travel Fund', type: 'savings', balance: 1450, institution: 'Community Bank' },
      { id: 'demo-credit', userId: DEMO_USER_ID, name: 'Everyday Rewards Card', type: 'credit', balance: 1842.35, institution: 'Example Credit Union', interestRate: 0.2199, minPayment: 65, plannedPayment: 250, includeInPaydown: true },
      { id: 'demo-auto-loan', userId: DEMO_USER_ID, name: 'Auto Loan', type: 'loan', balance: 11850, institution: 'Community Auto Finance', interestRate: 0.059, minPayment: 385, plannedPayment: 450, includeInPaydown: true },
      { id: 'demo-retirement', userId: DEMO_USER_ID, name: 'Retirement Portfolio', type: 'investment', balance: 28400, institution: 'Example Investments' },
    ]);

    await tx.insert(transactions).values(transactionTemplates.map((item) => ({
      id: `demo-${item.id}`,
      userId: DEMO_USER_ID,
      date: dateAtOffset(item.dayOffset),
      sourceDate: dateAtOffset(item.dayOffset),
      merchant: item.merchant,
      sourceCategory: item.category,
      sourceSubCategory: item.subCategory,
      sourceType: item.type,
      category: item.category,
      subCategory: item.subCategory,
      ...demoTransactionAssignment(item),
      accountId: item.accountId,
      account: item.accountName,
      amountCents: item.amountCents,
      type: item.type,
      notes: item.notes,
      externalId: `demo-${item.id}`,
      needsReview: item.needsReview ?? false,
    })));
    await tx.insert(transactionSplits).values([
      { id: 'demo-split-target-grocery', userId: DEMO_USER_ID, transactionId: 'demo-shopping-split', amountCents: 8238, category: 'Food & Dining', subCategory: '🛒 Groceries', ...demoAssignment('Food & Dining', '🛒 Groceries'), type: 'expense', sortOrder: 0 },
      { id: 'demo-split-target-household', userId: DEMO_USER_ID, transactionId: 'demo-shopping-split', amountCents: 6000, category: 'Shopping', subCategory: '🛋️ Furniture & Housewares', ...demoAssignment('Shopping', '🛋️ Furniture & Housewares'), type: 'expense', sortOrder: 1 },
    ]);

    // Planned income $6,500 − expenses $5,687 − paydown $700 = $113 left to budget.
    const budgets = [
      ['sub-paychecks', 6500],
      ['sub-charity', 75], ['sub-gifts', 50],
      ['sub-auto-payment', 385], ['sub-gas-fuel', 180], ['sub-auto-maintenance', 50],
      ['sub-parking-tolls', 20], ['sub-taxi-rideshares', 25],
      ['sub-rent', 1650], ['sub-home-improvement', 100],
      ['sub-garbage', 30], ['sub-water', 48], ['sub-gas-electric', 140],
      ['sub-internet-cable', 79], ['sub-phone', 68],
      ['sub-groceries', 650], ['sub-restaurants-bars', 550], ['sub-coffee-shops', 45],
      ['sub-travel-vacation', 400], ['sub-entertainment', 80], ['sub-personal', 100],
      ['sub-fun-money', 150],
      ['sub-shopping', 200], ['sub-clothing', 100], ['sub-furniture-housewares', 50],
      ['sub-electronics', 35],
      ['sub-medical', 100], ['sub-dentist', 25], ['sub-fitness', 45],
      ['sub-insurance', 132], ['sub-financial-fees', 10], ['sub-cash-atm', 50],
      ['sub-uncategorized', 25], ['sub-miscellaneous', 40],
    ] as const;
    await tx.insert(monthlyBudgets).values([currentMonth, previousMonth].flatMap((yearMonth) =>
      budgets.map(([subCategoryId, planned]) => ({
        userId: DEMO_USER_ID,
        subCategoryId: `${DEMO_USER_ID}:${subCategoryId}`,
        yearMonth,
        planned,
      })),
    ));

    await tx.insert(monthlyPaydown).values([
      { userId: DEMO_USER_ID, accountId: 'demo-credit', yearMonth: currentMonth, planned: 250 },
      { userId: DEMO_USER_ID, accountId: 'demo-auto-loan', yearMonth: currentMonth, planned: 450 },
    ]);
    await tx.insert(monthlyPaydownSnapshots).values({
      userId: DEMO_USER_ID,
      yearMonth: currentMonth,
      syncedAt: now,
      rowCount: 2,
    });
    await tx.insert(goals).values([
      { id: 'demo-goal-emergency', userId: DEMO_USER_ID, name: 'Six-month emergency fund', target: 15000, startingValue: 5000, accountId: 'demo-emergency' },
      { id: 'demo-goal-travel', userId: DEMO_USER_ID, name: 'Japan trip', target: 5000, startingValue: 500, accountId: 'demo-travel' },
      { id: 'demo-goal-retirement', userId: DEMO_USER_ID, name: 'First $25K invested', target: 25000, startingValue: 20000, accountId: 'demo-retirement' },
    ]);
    await tx.insert(rules).values([
      { id: 'demo-rule-market', userId: DEMO_USER_ID, matchValue: 'Fresh Market', accountId: 'demo-credit', sourceType: 'expense', sourceCategory: 'Food & Dining', sourceSubCategory: '🛒 Groceries', category: 'Food & Dining', subCategory: '🛒 Groceries', ...demoAssignment('Food & Dining', '🛒 Groceries'), type: 'expense' },
      { id: 'demo-rule-coffee', userId: DEMO_USER_ID, matchValue: 'Juniper Coffee', accountId: 'demo-credit', sourceType: 'expense', sourceCategory: 'Food & Dining', sourceSubCategory: '☕ Coffee Shops', category: 'Food & Dining', subCategory: '☕ Coffee Shops', ...demoAssignment('Food & Dining', '☕ Coffee Shops'), type: 'expense' },
    ]);
    await tx.insert(settings).values([
      { userId: DEMO_USER_ID, key: 'initial_categories_seeded', value: 'true' },
      { userId: DEMO_USER_ID, key: 'financial_onboarding', value: JSON.stringify({ version: 2, runId: null, status: 'completed', currentStep: 'complete', skippedSteps: [] }) },
    ]);
  });

  return { users: 1, transactions: transactionTemplates.length };
}
