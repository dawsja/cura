import { Hono } from 'hono';
import { asc, eq, getTableColumns } from 'drizzle-orm';
import { db } from '@/db/client';
import { accounts } from '@/db/schema/accounts';
import { categories } from '@/db/schema/categories';
import { goals } from '@/db/schema/goals';
import { monthlyBudgets } from '@/db/schema/monthly_budgets';
import { monthlyPaydown, monthlyPaydownSnapshots } from '@/db/schema/monthly_paydown';
import { rules } from '@/db/schema/rules';
import { settings } from '@/db/schema/settings';
import { subCategories } from '@/db/schema/sub_categories';
import { transactions } from '@/db/schema/transactions';
import { transactionSplits } from '@/db/schema/transaction_splits';
import { user } from '@/db/schema/auth';
import { safe } from '@/lib/errors';
import { retentionPolicy } from '@/lib/retention';
import { userId } from '@/lib/tenant';

// `revision` is an internal concurrency token, not part of the export format.
const { revision: _revision, ...exportedBudgetColumns } = getTableColumns(monthlyBudgets);

export const dataRoutes = new Hono();

const SENSITIVE_SETTING = /(?:secret|password|token|access_url)/i;

function attachment(c: import('hono').Context, filename: string, contentType: string): void {
  // Filenames are constants, not user input, so the header cannot be injected.
  c.header('Content-Type', contentType);
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  // Prevent spreadsheet formula execution while preserving the visible value.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

dataRoutes.get('/retention', (c) => {
  c.header('Cache-Control', 'private, no-store');
  const policy = retentionPolicy();
  return c.json({
    ...policy,
    description: policy.enabled
      ? `Transactions and budget history older than ${policy.days} days are deleted.`
      : 'Automatic financial-data deletion is disabled; history is retained until you delete it.',
  });
});

dataRoutes.get(
  '/export.json',
  safe(async (c) => {
    const uid = userId(c);
    const [profile, accountRows, categoryRows, subCategoryRows, transactionRows, splitRows, budgetRows, goalRows,
      paydownRows, paydownSnapshotRows, ruleRows, settingRows] = await db.transaction(async (tx) => Promise.all([
      tx.select({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt })
        .from(user).where(eq(user.id, uid)).limit(1),
      tx.select().from(accounts).where(eq(accounts.userId, uid)).orderBy(asc(accounts.createdAt)),
      tx.select().from(categories).where(eq(categories.userId, uid)).orderBy(asc(categories.sortOrder)),
      tx.select().from(subCategories).where(eq(subCategories.userId, uid)).orderBy(asc(subCategories.createdAt)),
      tx.select().from(transactions).where(eq(transactions.userId, uid)).orderBy(asc(transactions.date), asc(transactions.id)),
      tx.select().from(transactionSplits).where(eq(transactionSplits.userId, uid))
        .orderBy(asc(transactionSplits.transactionId), asc(transactionSplits.sortOrder)),
      tx.select(exportedBudgetColumns).from(monthlyBudgets).where(eq(monthlyBudgets.userId, uid))
        .orderBy(asc(monthlyBudgets.yearMonth)),
      tx.select().from(goals).where(eq(goals.userId, uid)).orderBy(asc(goals.createdAt)),
      tx.select().from(monthlyPaydown).where(eq(monthlyPaydown.userId, uid)).orderBy(asc(monthlyPaydown.yearMonth)),
      tx.select().from(monthlyPaydownSnapshots).where(eq(monthlyPaydownSnapshots.userId, uid))
        .orderBy(asc(monthlyPaydownSnapshots.yearMonth)),
      tx.select().from(rules).where(eq(rules.userId, uid)).orderBy(asc(rules.createdAt)),
      tx.select().from(settings).where(eq(settings.userId, uid)).orderBy(asc(settings.key)),
    ]));

    const splitsByTransaction = new Map<string, typeof splitRows>();
    for (const split of splitRows) {
      const list = splitsByTransaction.get(split.transactionId) ?? [];
      list.push(split);
      splitsByTransaction.set(split.transactionId, list);
    }

    attachment(c, 'cura-export.json', 'application/json; charset=utf-8');
    return c.body(JSON.stringify({
      format: 'cura-money-user-export',
      version: 2,
      exportedAt: new Date().toISOString(),
      user: profile[0] ?? null,
      data: {
        accounts: accountRows,
        categories: categoryRows,
        subCategories: subCategoryRows,
        transactions: transactionRows.map((transaction) => ({
          ...transaction,
          splits: splitsByTransaction.get(transaction.id) ?? [],
        })),
        monthlyBudgets: budgetRows,
        goals: goalRows,
        monthlyPaydown: paydownRows,
        monthlyPaydownSnapshots: paydownSnapshotRows,
        rules: ruleRows,
        settings: settingRows.filter((row) => !SENSITIVE_SETTING.test(row.key)),
      },
    }, null, 2));
  }),
);

dataRoutes.get(
  '/transactions.csv',
  safe(async (c) => {
    const uid = userId(c);
    const [rows, splitRows] = await db.transaction(async (tx) => Promise.all([
      tx
        .select()
        .from(transactions)
        .where(eq(transactions.userId, uid))
        .orderBy(asc(transactions.date), asc(transactions.id)),
      tx
        .select()
        .from(transactionSplits)
        .where(eq(transactionSplits.userId, uid))
        .orderBy(asc(transactionSplits.transactionId), asc(transactionSplits.sortOrder)),
    ]));
    const splitsByTransaction = new Map<string, typeof splitRows>();
    for (const split of splitRows) {
      const list = splitsByTransaction.get(split.transactionId) ?? [];
      list.push(split);
      splitsByTransaction.set(split.transactionId, list);
    }
    const header = ['date', 'merchant', 'category', 'sub_category', 'account', 'amount_usd', 'type', 'notes', 'needs_review', 'splits_json'];
    const lines = [header.map(csvCell).join(',')];
    for (const row of rows) {
      lines.push([
        row.date,
        row.merchant,
        row.category,
        row.subCategory,
        row.account,
        (row.amountCents / 100).toFixed(2),
        row.type,
        row.notes,
        row.needsReview,
        JSON.stringify((splitsByTransaction.get(row.id) ?? []).map((split) => ({
          id: split.id,
          amountCents: split.amountCents,
          category: split.category,
          subCategory: split.subCategory,
          type: split.type,
          sortOrder: split.sortOrder,
        }))),
      ].map(csvCell).join(','));
    }

    attachment(c, 'cura-transactions.csv', 'text/csv; charset=utf-8');
    return c.body(`\uFEFF${lines.join('\r\n')}\r\n`);
  }),
);
