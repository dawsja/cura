/**
 * MCP tools that change data, registered only for tokens with the
 * `finance:write` scope. Each one runs the same query helpers and checks as
 * the matching web app action, so an agent cannot do anything the UI would
 * refuse:
 *
 *   Transactions page   categorize_transaction (category picker, plus the
 *                       "Create scoped rule" follow-up), bulk_categorize_
 *                       transactions (Budget drill-down "Move"),
 *                       add_transaction, update_transaction,
 *                       split_transaction, delete_transaction.
 *   Accounts page       add_account, update_account, set_account_hidden,
 *                       delete_account, sync_bank_accounts ("Sync now").
 *   Review modal        review_transaction, accept_all_reviews.
 *   Rules page          create_rule, create_rule_from_transaction,
 *                       update_rule, delete_rule, run_rules.
 *   Budget page         set_budget (+ "Apply to future months"),
 *                       set_debt_payment, save_debt_plan_to_budget.
 *   Pay down page       update_paydown_settings.
 *   Categories page     create_category, create_subcategory,
 *                       rename_category, rename_subcategory,
 *                       delete_category, delete_subcategory,
 *                       reorder_categories.
 *   Goals page          create_goal, update_goal, delete_goal.
 *   Recurring           set_recurring_charge (Transactions page recurring
 *                       picker), remove_recurring_charge ("None"/dismiss),
 *                       add_manual_recurring_charge, update_manual_
 *                       recurring_charge (Recurring page form).
 *
 * As in the UI, changing a transaction never creates or edits a rule by
 * itself, and a new rule only touches existing transactions when it is run.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '@/db/client';
import {
  addAccount,
  addGoal,
  addMainCategory,
  addSubCategory,
  addTransaction,
  applyAllRulesToMatchingTransactions,
  applyRuleToAllMatchingTransactions,
  bulkAssignTransactions,
  createRule,
  createRuleFromTransaction,
  deleteAccount,
  deleteGoal,
  deleteMainCategory,
  deleteRule,
  deleteSubCategory,
  deleteTransaction,
  editAccount,
  editAccountPaydown,
  editGoal,
  editMainCategory,
  editRule,
  editSubCategory,
  editTransaction,
  getAccount,
  getAllCategories,
  getAllGoals,
  getSetting,
  getRecurringTransactionMetadata,
  getTransactionAssignment,
  listRules,
  markTransactionReviewed,
  pendingReviewCount,
  reorderMainCategories,
  resolveRecurringTransactionMetadata,
  setAccountHidden,
  setSetting,
  skipAllPendingReviews,
  updateFullTransaction,
  type Account,
  type MainCategory,
  type Rule,
  type RuleFromTransactionResult,
  type TransactionType,
} from '@/db/queries';
import { MainCategoryName } from '@/lib/category-name';
import { logger } from '@/lib/logger';
import { aprRate, dollarsToCents, moneyAmount, positiveMoneyAmount } from '@/lib/money';
import { publicSimpleFinError, syncSimpleFinToDatabase } from '@/lib/simplefin';
import { applyBudgetToFutureMonths, saveDebtPlanToBudget, setMonthlyBudget, setPlannedDebtPayment } from '@/services/budget';
import {
  addManualRecurring,
  deleteManualRecurring,
  dismissRecurring,
  listManualRecurring,
  loadActiveRecurringCharges,
  manualRecurringInputSchema,
  markRecurring,
  recurringSchedule,
  updateManualRecurring,
} from '@/services/recurring';
import { buildBudgetView } from './budget-view';
import {
  CalendarDate,
  DESTRUCTIVE,
  TxType,
  WRITE,
  YearMonth,
  currentYearMonth,
  defineTool,
  run,
  userError,
  type McpContext,
} from './tool-kit';

const PAY_DOWN_GOALS = 'Pay down goals';

const Id = z.string().min(1).max(500);
const CategoryName = z.string().min(1).max(120);
const AccountType = z.enum(['checking', 'savings', 'credit', 'investment', 'loan']);

interface Assignment {
  category: string;
  subCategory: string;
  type: TransactionType;
}

/**
 * Resolve a category pick the way the UI's category picker does: the names
 * must name one main category and one of its sub-categories, and choosing a
 * category from another type's tab switches the type. Names match exactly,
 * or else case-insensitively when that is unambiguous; the canonical names
 * are returned. Pay down goals accepts any type, so it keeps
 * `keepType` (the transaction's own type) when one is given.
 */
function resolveAssignment(
  categories: MainCategory[],
  pick: { category: string; subCategory: string; type?: TransactionType },
  keepType?: TransactionType,
): Assignment {
  const byName = <T extends { name: string }>(list: T[], name: string): T[] => {
    const exact = list.filter((item) => item.name === name.trim());
    if (exact.length > 0) return exact;
    const folded = name.trim().toLowerCase();
    return list.filter((item) => item.name.trim().toLowerCase() === folded);
  };
  const mains = byName(categories, pick.category);
  if (mains.length === 0) {
    throw userError(`No category named "${pick.category}". Call list_categories for the user's categories.`);
  }
  if (mains.length > 1) throw userError(`More than one category is named "${pick.category}"; rename one in the app first.`);
  const main = mains[0]!;
  const subs = byName(main.subCategories, pick.subCategory);
  if (subs.length !== 1) {
    const names = main.subCategories.map((s) => s.name).join(', ') || 'none';
    throw userError(`"${main.name}" has no sub-category named "${pick.subCategory}". Its sub-categories: ${names}.`);
  }
  const type = pick.type ?? (main.name === PAY_DOWN_GOALS && keepType ? keepType : main.type);
  if (type !== main.type && main.name !== PAY_DOWN_GOALS) {
    throw userError(`"${main.name}" is an ${main.type} category, so the type must be ${main.type}.`);
  }
  return { category: main.name, subCategory: subs[0]!.name, type };
}

function sameAssignment(a: Assignment, b: { category: string; subCategory: string | null; type: TransactionType }): boolean {
  return a.category === b.category && a.subCategory === b.subCategory && a.type === b.type;
}

function describeRule(rule: Rule) {
  return {
    id: rule.id,
    version: rule.version,
    matchValue: rule.matchValue,
    accountId: rule.accountId ?? null,
    sourceType: rule.sourceType ?? null,
    sourceCategory: rule.sourceCategory ?? null,
    sourceSubCategory: rule.sourceSubCategory ?? null,
    category: rule.category,
    subCategory: rule.subCategory ?? null,
    type: rule.type ?? null,
  };
}

const RULE_OUTCOMES: Record<RuleFromTransactionResult['status'], string> = {
  created: 'Created a rule for future imports of this merchant on this account.',
  narrowed: 'Narrowed the existing merchant-wide rule to this account and assignment.',
  updated: 'Replaced the existing rule\'s assignment.',
  unchanged: 'A rule with this assignment already exists.',
  confirmation_required:
    'An existing rule already covers this merchant with a different assignment, so nothing was changed. Ask the '
    + 'user, then call create_rule_from_transaction with replaceRuleId and expectedVersion from `rule` to replace it.',
};

function describeRuleResult(result: RuleFromTransactionResult) {
  return { status: result.status, message: RULE_OUTCOMES[result.status], rule: describeRule(result.rule) };
}

/** The rule runners report problems as plain errors; they are the user's to fix. */
async function runRules(userId: string, ruleId?: string): Promise<number> {
  try {
    const result = ruleId
      ? await applyRuleToAllMatchingTransactions(userId, ruleId)
      : await applyAllRulesToMatchingTransactions(userId);
    return result.updated;
  } catch (err) {
    if (typeof (err as { status?: unknown }).status === 'number') throw err;
    throw userError(err instanceof Error ? err.message : 'rule run failed');
  }
}

async function requireTransaction(userId: string, id: string) {
  const transaction = await getTransactionAssignment(userId, id);
  if (!transaction) throw userError(`No transaction with id ${id}. Use search_transactions to find ids.`, 404);
  return transaction;
}

function rejectSplit(transaction: { splitCount: number }) {
  if (transaction.splitCount > 0) {
    throw userError(
      `This transaction is split into ${transaction.splitCount} allocations, each with its own category. `
      + 'Change or remove the split with split_transaction first.',
      409,
    );
  }
}

const Frequency = z.enum(['weekly', 'monthly', 'yearly']);

type ActiveCharge = Awaited<ReturnType<typeof loadActiveRecurringCharges>>[number];

function describeCharge(charge: ActiveCharge) {
  return { ...charge, ...recurringSchedule(charge.lastDate, charge.frequency) };
}

/** Active charges for a merchant, narrowed by account id or name when given (names compare case-insensitively). */
function matchCharges(
  charges: ActiveCharge[],
  identity: { merchant: string; account?: string; accountId?: string },
): ActiveCharge[] {
  const merchant = identity.merchant.trim().toLowerCase();
  const account = identity.account?.trim().toLowerCase();
  return charges.filter((charge) => {
    if (charge.merchant.toLowerCase() !== merchant) return false;
    if (identity.accountId) return charge.accountId === identity.accountId;
    if (account) return charge.account.toLowerCase() === account;
    return true;
  });
}

function requireOneCharge(matches: ActiveCharge[], merchant: string): ActiveCharge {
  if (matches.length === 0) {
    throw userError(`No recurring charge for "${merchant}". Call list_recurring_charges.`, 404);
  }
  if (matches.length > 1) {
    throw userError(`More than one recurring charge matches "${merchant}"; pass accountId (or id for a manual entry).`);
  }
  return matches[0]!;
}

function describeAccount(account: Account) {
  return {
    id: account.id,
    name: account.alias || account.name,
    canonicalName: account.name,
    alias: account.alias ?? null,
    type: account.type,
    balance: account.balance,
    institution: account.institution ?? null,
    source: account.source,
    hidden: account.hidden,
    interestRate: account.interestRate,
    minPayment: account.minPayment,
    plannedPayment: account.plannedPayment,
    includeInPaydown: account.includeInPaydown,
  };
}

async function requireAccount(userId: string, id: string): Promise<Account> {
  const account = await getAccount(userId, id);
  if (!account) throw userError(`No account with id ${id}. Call list_accounts with includeHidden.`, 404);
  return account;
}

function findSubCategory(categories: MainCategory[], subCategoryId: string) {
  for (const main of categories) {
    const sub = main.subCategories.find((s) => s.id === subCategoryId);
    if (sub) return { main, sub };
  }
  throw userError(`No sub-category with id ${subCategoryId}. Call list_categories.`, 404);
}

function requireMainCategory(categories: MainCategory[], categoryId: string): MainCategory {
  const main = categories.find((c) => c.id === categoryId);
  if (!main) throw userError(`No category with id ${categoryId}. Call list_categories.`, 404);
  return main;
}

async function requireGoal(userId: string, id: string) {
  const goal = (await getAllGoals(userId)).find((g) => g.id === id);
  if (!goal) throw userError(`No goal with id ${id}. Call list_goals.`, 404);
  return goal;
}

/** Thrown query errors with a 4xx status are already user-facing; plain ones become 400s. */
async function asUserError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (typeof (err as { status?: unknown }).status === 'number') throw err;
    throw userError(err instanceof Error ? err.message : 'request failed');
  }
}

export function registerWriteTools(server: McpServer, ctx: McpContext): void {
  const { userId } = ctx;

  // ---- Transactions --------------------------------------------------------

  defineTool(
    server,
    'categorize_transaction',
    {
      title: 'Change a transaction\'s category',
      description:
        'Set a transaction\'s category and sub-category, like picking one on the Transactions page. The type follows '
        + 'the category (income, expense, or transfer) unless given; Pay down goals keeps the transaction\'s type. '
        + 'This also clears the transaction from the review queue. It does not create a rule unless createRule is '
        + 'true, which adds a rule scoped to this merchant, account, and the bank\'s original classification so '
        + 'future imports are categorized the same way. Split transactions are refused.',
      inputSchema: {
        transactionId: Id.describe('From search_transactions or list_pending_reviews.'),
        category: CategoryName.describe('Main category name.'),
        subCategory: CategoryName.describe('Sub-category name within that category.'),
        type: TxType.optional().describe('Usually omitted; inferred from the category.'),
        createRule: z.boolean().optional().describe('Also create a rule for future imports of this merchant on this account.'),
      },
      annotations: WRITE,
    },
    run('categorize_transaction', ctx, async (args) => {
      const transaction = await requireTransaction(userId, args.transactionId);
      rejectSplit(transaction);
      const assignment = resolveAssignment(await getAllCategories(userId), args, transaction.type);
      const changed = !sameAssignment(assignment, transaction);
      if (changed) await editTransaction(userId, transaction.id, assignment);
      const rule = args.createRule ? describeRuleResult(await createRuleFromTransaction(userId, transaction.id)) : null;
      return {
        status: changed ? 'updated' : 'unchanged',
        transaction: { id: transaction.id, merchant: transaction.merchant, account: transaction.account, ...assignment },
        previous: { category: transaction.category, subCategory: transaction.subCategory, type: transaction.type },
        removedFromReviewQueue: changed && transaction.needsReview,
        rule,
      };
    }, { audit: true }),
  );

  defineTool(
    server,
    'bulk_categorize_transactions',
    {
      title: 'Move transactions to a category',
      description:
        'Move up to 100 transactions to one category and sub-category in a single all-or-nothing change, like '
        + '"Move" in a Budget line\'s transaction list. Transactions leave the review queue; rules are not changed. '
        + 'Split transactions are refused. Confirm with the user before moving many transactions.',
      inputSchema: {
        transactionIds: z.array(Id).min(1).max(100),
        category: CategoryName,
        subCategory: CategoryName,
        type: TxType.optional().describe('Usually omitted; inferred from the category.'),
      },
      annotations: WRITE,
    },
    run('bulk_categorize_transactions', ctx, async (args) => {
      const ids = [...new Set(args.transactionIds)];
      const rows = await Promise.all(ids.map((id) => requireTransaction(userId, id)));
      const split = rows.filter((row) => row.splitCount > 0);
      if (split.length > 0) {
        throw userError(`Split transactions cannot be moved: ${split.map((row) => row.id).join(', ')}. Leave them out.`, 409);
      }
      const categories = await getAllCategories(userId);
      const types = new Set(rows.map((row) => row.type));
      // Pay down goals keeps each transaction's own type, so a mixed batch needs an explicit type.
      const fallback = rows[0]!.type;
      if (!args.type && types.size > 1 && args.category.trim().toLowerCase() === PAY_DOWN_GOALS.toLowerCase()) {
        throw userError('These transactions have different types; pass type to move them to Pay down goals.');
      }
      const target = resolveAssignment(categories, args, fallback);

      // The Budget page moves rows that share one current assignment; group
      // by the current assignment and move every group in one transaction.
      const groups = new Map<string, { expected: { type: TransactionType; category: string; subCategory: string }; ids: string[] }>();
      let unchanged = 0;
      for (const row of rows) {
        if (sameAssignment(target, row)) {
          unchanged += 1;
          continue;
        }
        if (!row.subCategory) {
          // Rows without a sub-category can't be matched by the bulk check; move them one at a time.
          groups.set(`single\0${row.id}`, { expected: { type: row.type, category: row.category, subCategory: '' }, ids: [row.id] });
          continue;
        }
        const key = `${row.type}\0${row.category}\0${row.subCategory}`;
        const group = groups.get(key) ?? { expected: { type: row.type, category: row.category, subCategory: row.subCategory }, ids: [] };
        group.ids.push(row.id);
        groups.set(key, group);
      }
      let moved = 0;
      await db.transaction(async () => {
        for (const group of groups.values()) {
          if (!group.expected.subCategory) {
            await editTransaction(userId, group.ids[0]!, target);
            moved += 1;
            continue;
          }
          moved += await bulkAssignTransactions(userId, { ids: group.ids, expected: group.expected, ...target });
        }
      });
      return { moved, alreadyInCategory: unchanged, ...target };
    }, { audit: true }),
  );

  defineTool(
    server,
    'add_transaction',
    {
      title: 'Add a transaction',
      description:
        'Add a manual transaction, like "Add transaction" on the Transactions page. The amount is positive; the type '
        + 'follows the category unless given. Manual transactions do not need review.',
      inputSchema: {
        date: CalendarDate,
        merchant: z.string().trim().min(1).max(255),
        amount: moneyAmount,
        accountId: Id.describe('From list_accounts.'),
        category: CategoryName,
        subCategory: CategoryName,
        type: TxType.optional().describe('Usually omitted; inferred from the category.'),
        notes: z.string().max(2000).optional(),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    run('add_transaction', ctx, async (args) => {
      const account = await requireAccount(userId, args.accountId);
      const assignment = resolveAssignment(await getAllCategories(userId), args);
      const transaction = await asUserError(() => addTransaction(userId, {
        date: args.date,
        merchant: args.merchant,
        amount: args.amount,
        account: account.name,
        accountId: account.id,
        notes: args.notes,
        ...assignment,
      }));
      return {
        transaction: {
          id: transaction.id,
          date: transaction.date,
          merchant: transaction.merchant,
          amount: transaction.amount,
          type: transaction.type,
          category: transaction.category,
          subCategory: transaction.subCategory ?? null,
          account: account.alias || account.name,
          accountId: account.id,
          notes: transaction.notes ?? null,
        },
      };
    }, { audit: true }),
  );

  defineTool(
    server,
    'update_transaction',
    {
      title: 'Edit a transaction',
      description:
        'Change a transaction\'s date, merchant, amount, account, notes, or category, like the Transactions page '
        + 'editor. Only the fields given change; pass notes as null to clear them. Category and subCategory go '
        + 'together. Changing the amount of a split transaction removes its split. Editing a transaction clears it '
        + 'from the review queue; rules are not changed.',
      inputSchema: {
        transactionId: Id,
        date: CalendarDate.optional(),
        merchant: z.string().trim().min(1).max(255).optional(),
        amount: moneyAmount.optional(),
        accountId: Id.optional().describe('Move it to this account (list_accounts).'),
        notes: z.string().max(2000).nullable().optional(),
        category: CategoryName.optional(),
        subCategory: CategoryName.optional(),
        type: TxType.optional().describe('Usually omitted; inferred from the category.'),
      },
      annotations: WRITE,
    },
    run('update_transaction', ctx, async (args) => {
      const transaction = await requireTransaction(userId, args.transactionId);
      if ((args.category === undefined) !== (args.subCategory === undefined)) {
        throw userError('Pass category and subCategory together.');
      }
      if (args.category === undefined && args.type !== undefined) {
        throw userError('Pass category and subCategory when changing the type.');
      }
      const assignment = args.category !== undefined && args.subCategory !== undefined
        ? resolveAssignment(
          await getAllCategories(userId),
          { category: args.category, subCategory: args.subCategory, type: args.type },
          transaction.type,
        )
        : null;
      if (assignment && !sameAssignment(assignment, transaction)) rejectSplit(transaction);
      const account = args.accountId ? await requireAccount(userId, args.accountId) : null;
      const patch = {
        ...(args.date !== undefined ? { date: args.date } : {}),
        ...(args.merchant !== undefined ? { merchant: args.merchant } : {}),
        ...(args.amount !== undefined ? { amount: args.amount } : {}),
        // The editor clears notes by saving an empty string.
        ...(args.notes !== undefined ? { notes: args.notes?.trim() ?? '' } : {}),
        ...(account ? { account: account.name, accountId: account.id } : {}),
        ...(assignment && !sameAssignment(assignment, transaction) ? assignment : {}),
      };
      if (Object.keys(patch).length === 0) return { status: 'unchanged', transaction };
      await asUserError(() => editTransaction(userId, transaction.id, patch));
      const after = await requireTransaction(userId, transaction.id);
      return {
        status: 'updated',
        transaction: after,
        changed: Object.keys(patch),
        splitRemoved: transaction.splitCount > 0 && after.splitCount === 0,
      };
    }, { audit: true }),
  );

  defineTool(
    server,
    'split_transaction',
    {
      title: 'Split a transaction',
      description:
        'Split one transaction across several categories, like "Split" in the Transactions page editor. Give at least '
        + 'two allocations whose amounts add up exactly to the transaction amount; each type follows its category '
        + 'unless given. Pass an empty list to remove the split.',
      inputSchema: {
        transactionId: Id,
        splits: z.array(z.object({
          amount: positiveMoneyAmount,
          category: CategoryName,
          subCategory: CategoryName,
          type: TxType.optional(),
        })).max(100),
      },
      annotations: WRITE,
    },
    run('split_transaction', ctx, async (args) => {
      const transaction = await requireTransaction(userId, args.transactionId);
      if (args.splits.length === 1) throw userError('A split needs at least two allocations, or none to remove it.');
      const categories = await getAllCategories(userId);
      const splits = args.splits.map((split) => {
        const assignment = resolveAssignment(categories, split, transaction.type);
        return { ...assignment, amountCents: dollarsToCents(split.amount) };
      });
      const updated = await asUserError(() => updateFullTransaction(userId, transaction.id, { transaction: {}, splits }));
      return {
        transaction: {
          id: updated.id,
          date: updated.date,
          merchant: updated.merchant,
          amount: updated.amount,
          type: updated.type,
          category: updated.category,
          subCategory: updated.subCategory ?? null,
          account: updated.account,
          splits: (updated.splits ?? []).map((s) => ({
            amount: s.amount,
            type: s.type,
            category: s.category,
            subCategory: s.subCategory,
          })),
        },
      };
    }, { audit: true }),
  );

  defineTool(
    server,
    'delete_transaction',
    {
      title: 'Delete a transaction',
      description:
        'Delete a transaction, like the Transactions page. A bank-imported transaction is also ignored by future '
        + 'syncs so it does not come back. Confirm with the user first.',
      inputSchema: { transactionId: Id },
      annotations: DESTRUCTIVE,
    },
    run('delete_transaction', ctx, async ({ transactionId }) => {
      const transaction = await requireTransaction(userId, transactionId);
      await deleteTransaction(userId, transaction.id);
      return { deleted: transaction };
    }, { audit: true }),
  );

  // ---- Review queue ---------------------------------------------------------

  defineTool(
    server,
    'review_transaction',
    {
      title: 'Review a transaction',
      description:
        'Resolve one item from list_pending_reviews, like the review dialog. Omit category and subCategory to keep '
        + 'the suggested category; pass them to change it. createRule also adds a rule for future imports of this '
        + 'merchant on this account (the dialog\'s "remember" option).',
      inputSchema: {
        transactionId: Id,
        category: CategoryName.optional(),
        subCategory: CategoryName.optional(),
        type: TxType.optional().describe('Usually omitted; inferred from the category.'),
        createRule: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    run('review_transaction', ctx, async (args) => {
      const transaction = await requireTransaction(userId, args.transactionId);
      if (!transaction.needsReview) throw userError('This transaction is not awaiting review.', 409);
      if ((args.category === undefined) !== (args.subCategory === undefined)) {
        throw userError('Pass category and subCategory together, or neither to keep the suggestion.');
      }
      if (args.category === undefined && args.type !== undefined) {
        throw userError('Pass category and subCategory when changing the type.');
      }
      let assignment: Assignment | null = null;
      if (args.category !== undefined && args.subCategory !== undefined) {
        const picked = resolveAssignment(
          await getAllCategories(userId),
          { category: args.category, subCategory: args.subCategory, type: args.type },
          transaction.type,
        );
        // An untouched suggestion only clears the review flag, as in the dialog.
        if (!sameAssignment(picked, transaction)) assignment = picked;
      }
      if (assignment) rejectSplit(transaction);
      const row = await markTransactionReviewed(userId, transaction.id, assignment ?? {});
      if (!row) throw userError('This transaction is not awaiting review.', 409);
      const rule = args.createRule ? describeRuleResult(await createRuleFromTransaction(userId, transaction.id)) : null;
      return {
        status: assignment ? 'recategorized' : 'accepted',
        transaction: {
          id: row.id,
          merchant: row.merchant,
          account: row.account,
          category: row.category,
          subCategory: row.subCategory ?? null,
          type: row.type,
        },
        rule,
        remainingToReview: await pendingReviewCount(userId),
      };
    }, { audit: true }),
  );

  defineTool(
    server,
    'accept_all_reviews',
    {
      title: 'Accept all suggested categories',
      description:
        'Clear the whole review queue and keep every suggested category, like "Accept all" in the review dialog. '
        + 'Confirm with the user first.',
      annotations: WRITE,
    },
    run('accept_all_reviews', ctx, async () => ({ accepted: await skipAllPendingReviews(userId) }), { audit: true }),
  );

  // ---- Rules ----------------------------------------------------------------

  defineTool(
    server,
    'create_rule',
    {
      title: 'Create a rule',
      description:
        'Add a categorization rule, like the Rules page. matchValue matches the merchant exactly or as a prefix, '
        + 'ignoring case and extra spaces. Optional conditions narrow it to one account and to the type/category the '
        + 'bank import assigned (sourceCategory and sourceSubCategory together). New rules apply to future imports; '
        + 'set runNow to also re-categorize existing matching transactions the user has not changed by hand.',
      inputSchema: {
        matchValue: z.string().min(1).max(255),
        category: CategoryName,
        subCategory: CategoryName,
        type: TxType.optional().describe('Usually omitted; inferred from the category.'),
        accountId: Id.optional().describe('Only match transactions on this account (list_accounts).'),
        sourceType: TxType.optional().describe('Only match when the import classified it as this type.'),
        sourceCategory: CategoryName.optional(),
        sourceSubCategory: CategoryName.optional(),
        runNow: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    run('create_rule', ctx, async (args) => {
      if ((args.sourceCategory === undefined) !== (args.sourceSubCategory === undefined)) {
        throw userError('sourceCategory and sourceSubCategory must be provided together');
      }
      if (args.accountId && !(await getAccount(userId, args.accountId))) {
        throw userError('accountId must belong to the user; see list_accounts', 404);
      }
      const target = resolveAssignment(await getAllCategories(userId), args);
      const rule = await createRule(userId, {
        matchValue: args.matchValue,
        accountId: args.accountId,
        sourceType: args.sourceType,
        sourceCategory: args.sourceCategory,
        sourceSubCategory: args.sourceSubCategory,
        ...target,
      });
      const updated = args.runNow ? await runRules(userId, rule.id) : null;
      return { rule: describeRule(rule), transactionsUpdated: updated };
    }, { audit: true }),
  );

  defineTool(
    server,
    'create_rule_from_transaction',
    {
      title: 'Create a rule from a transaction',
      description:
        'Make future imports of this transaction\'s merchant on its account get the transaction\'s current category, '
        + 'like "Create scoped rule" after a correction. If an existing rule conflicts, nothing changes and the result '
        + 'is confirmation_required with that rule; after the user agrees, call again with replaceRuleId and '
        + 'expectedVersion from it.',
      inputSchema: {
        transactionId: Id,
        replaceRuleId: Id.optional(),
        expectedVersion: z.number().int().positive().optional(),
      },
      annotations: WRITE,
    },
    run('create_rule_from_transaction', ctx, async (args) => {
      await requireTransaction(userId, args.transactionId);
      return describeRuleResult(
        await createRuleFromTransaction(userId, args.transactionId, args.replaceRuleId, args.expectedVersion),
      );
    }, { audit: true }),
  );

  defineTool(
    server,
    'update_rule',
    {
      title: 'Update a rule',
      description:
        'Edit a rule from list_rules. Pass its current version as expectedVersion; the change is refused if the rule '
        + 'changed since. Only the fields given change; pass null to clear an optional condition.',
      inputSchema: {
        ruleId: Id,
        expectedVersion: z.number().int().positive(),
        matchValue: z.string().min(1).max(255).optional(),
        category: CategoryName.optional(),
        subCategory: CategoryName.optional(),
        type: TxType.optional().describe('Usually omitted; inferred from the category.'),
        accountId: Id.nullable().optional(),
        sourceType: TxType.nullable().optional(),
        sourceCategory: CategoryName.nullable().optional(),
        sourceSubCategory: CategoryName.nullable().optional(),
        runNow: z.boolean().optional().describe('Re-apply the rule to existing matching transactions afterwards.'),
      },
      annotations: WRITE,
    },
    run('update_rule', ctx, async (args) => {
      const sourceChanged = args.sourceCategory !== undefined || args.sourceSubCategory !== undefined;
      if (sourceChanged) {
        const bothNull = args.sourceCategory === null && args.sourceSubCategory === null;
        const bothSet = typeof args.sourceCategory === 'string' && typeof args.sourceSubCategory === 'string';
        if (!bothNull && !bothSet) throw userError('sourceCategory and sourceSubCategory must be changed together');
      }
      if (args.accountId && !(await getAccount(userId, args.accountId))) {
        throw userError('accountId must belong to the user; see list_accounts', 404);
      }
      if ((args.category === undefined) !== (args.subCategory === undefined)) {
        throw userError('category and subCategory are required when changing the assignment');
      }
      const existing = (await listRules(userId)).find((rule) => rule.id === args.ruleId);
      if (!existing) throw userError(`No rule with id ${args.ruleId}. Call list_rules.`, 404);
      const target = args.category !== undefined && args.subCategory !== undefined
        ? resolveAssignment(
          await getAllCategories(userId),
          { category: args.category, subCategory: args.subCategory, type: args.type },
          existing.type,
        )
        : null;
      const rule = await editRule(userId, args.ruleId, {
        matchValue: args.matchValue,
        accountId: args.accountId,
        sourceType: args.sourceType,
        sourceCategory: args.sourceCategory,
        sourceSubCategory: args.sourceSubCategory,
        ...(target ?? (args.type !== undefined ? { type: args.type } : {})),
      }, args.expectedVersion);
      const updated = args.runNow ? await runRules(userId, rule.id) : null;
      return { rule: describeRule(rule), transactionsUpdated: updated };
    }, { audit: true }),
  );

  defineTool(
    server,
    'delete_rule',
    {
      title: 'Delete a rule',
      description: 'Delete a rule. Transactions it already categorized keep their category. Confirm with the user first.',
      inputSchema: { ruleId: Id },
      annotations: DESTRUCTIVE,
    },
    run('delete_rule', ctx, async ({ ruleId }) => {
      const existing = (await listRules(userId)).find((rule) => rule.id === ruleId);
      if (!existing) throw userError(`No rule with id ${ruleId}. Call list_rules.`, 404);
      await deleteRule(userId, ruleId);
      return { deleted: describeRule(existing) };
    }, { audit: true }),
  );

  defineTool(
    server,
    'run_rules',
    {
      title: 'Run rules on existing transactions',
      description:
        'Re-apply one rule, or every rule (best match wins, as on import), to existing transactions. Transactions '
        + 'the user categorized by hand and split transactions are left alone. Returns how many changed.',
      inputSchema: { ruleId: Id.optional().describe('Omit to run every rule, like "Run all".') },
      annotations: WRITE,
    },
    run('run_rules', ctx, async ({ ruleId }) => {
      if (ruleId && !(await listRules(userId)).some((rule) => rule.id === ruleId)) {
        throw userError(`No rule with id ${ruleId}. Call list_rules.`, 404);
      }
      return { transactionsUpdated: await runRules(userId, ruleId) };
    }, { audit: true }),
  );

  // ---- Budget ---------------------------------------------------------------

  defineTool(
    server,
    'set_budget',
    {
      title: 'Set a budget amount',
      description:
        'Set the planned amount for an income or expense sub-category in one month, like editing a Budget page cell. '
        + 'Later months keep their own amounts unless applyToFutureMonths is true, which carries this amount forward '
        + 'to every later month (the page\'s "Apply to future months"). Debt payments use set_debt_payment.',
      inputSchema: {
        subCategoryId: Id.describe('From get_budget or list_categories.'),
        planned: moneyAmount,
        month: YearMonth.optional().describe('YYYY-MM; defaults to the current month.'),
        applyToFutureMonths: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    run('set_budget', ctx, async (args) => {
      const yearMonth = args.month ?? currentYearMonth();
      const categories = await getAllCategories(userId);
      const main = categories.find((c) => c.subCategories.some((s) => s.id === args.subCategoryId));
      const sub = main?.subCategories.find((s) => s.id === args.subCategoryId);
      if (!main || !sub) throw userError(`No sub-category with id ${args.subCategoryId}. Call get_budget.`, 404);
      if (main.name === PAY_DOWN_GOALS) throw userError('Debt payments are set with set_debt_payment.');
      if (main.type === 'transfer') throw userError('Transfer categories are not budgeted.');

      const before = await buildBudgetView(userId, yearMonth);
      const current = before.groups.flatMap((g) => g.lines).find((l) => l.subCategoryId === sub.id);
      let status: 'updated' | 'unchanged' = 'updated';
      let appliedToFutureMonths = false;
      // The page only saves a cell whose value changed.
      if (current?.planned === args.planned && !args.applyToFutureMonths) {
        status = 'unchanged';
      } else {
        const { revision } = await setMonthlyBudget(userId, { subCategoryId: sub.id, yearMonth, planned: args.planned });
        if (args.applyToFutureMonths) {
          appliedToFutureMonths = await applyBudgetToFutureMonths(userId, { subCategoryId: sub.id, yearMonth, revision });
          if (!appliedToFutureMonths) throw userError('This budget changed while saving; try again.', 409);
        }
      }
      const after = await buildBudgetView(userId, yearMonth);
      return {
        status,
        month: yearMonth,
        line: after.groups.flatMap((g) => g.lines).find((l) => l.subCategoryId === sub.id) ?? null,
        appliedToFutureMonths,
        totals: after.totals,
      };
    }, { audit: true }),
  );

  defineTool(
    server,
    'set_debt_payment',
    {
      title: 'Set a planned debt payment',
      description:
        'Set the planned payment for a credit card or loan in a month, like editing a row in the Budget page\'s Pay '
        + 'down section. It also becomes the account\'s planned payment on the Pay down page. It cannot be below '
        + 'the minimum payment (or the balance, if smaller).',
      inputSchema: {
        accountId: Id.describe('A credit or loan account from list_accounts or get_budget.'),
        planned: moneyAmount,
        month: YearMonth.optional().describe('YYYY-MM; defaults to the current month.'),
      },
      annotations: WRITE,
    },
    run('set_debt_payment', ctx, async (args) => {
      const yearMonth = args.month ?? currentYearMonth();
      await setPlannedDebtPayment(userId, { accountId: args.accountId, yearMonth, planned: args.planned });
      const view = await buildBudgetView(userId, yearMonth);
      return {
        month: yearMonth,
        debtPayment: view.debtPayments.accounts.find((a) => a.accountId === args.accountId) ?? null,
        totals: view.totals,
      };
    }, { audit: true }),
  );

  defineTool(
    server,
    'save_debt_plan_to_budget',
    {
      title: 'Save the debt paydown plan to the budget',
      description:
        'Pay down page "Save to Budget": plan this month\'s debt payments from a paydown method and replace the Pay '
        + 'down section of the budget from this month on. `planned` uses each account\'s planned payment; '
        + '`avalanche` and `snowball` add the extras to the priority debt. Preview with get_debt_paydown_projection.',
      inputSchema: {
        method: z.enum(['planned', 'avalanche', 'snowball']),
        monthlyExtra: moneyAmount.optional().describe('Ignored for planned.'),
        oneTimeExtra: moneyAmount.optional().describe('Ignored for planned.'),
        month: YearMonth.optional().describe('YYYY-MM; defaults to the current month.'),
      },
      annotations: WRITE,
    },
    run('save_debt_plan_to_budget', ctx, async (args) => {
      const yearMonth = args.month ?? currentYearMonth();
      const saved = await saveDebtPlanToBudget(userId, {
        yearMonth,
        method: args.method,
        monthlyExtra: args.monthlyExtra ?? 0,
        oneTimeExtra: args.oneTimeExtra ?? 0,
      });
      const view = await buildBudgetView(userId, yearMonth);
      return {
        month: yearMonth,
        scenario: saved.scenario,
        accountsPlanned: saved.rowCount,
        debtPayments: view.debtPayments.accounts,
        totals: view.totals,
      };
    }, { audit: true }),
  );

  defineTool(
    server,
    'update_paydown_settings',
    {
      title: 'Edit a debt\'s paydown settings',
      description:
        'Set a credit card or loan\'s APR, minimum payment, planned monthly payment, or whether it is included in '
        + 'paydown, like the Pay down page. interestRate is a fraction (0.2499 for 24.99%). The minimum must stay '
        + 'above 0 and a planned payment cannot be below it. To plan one month\'s payment on the budget, use '
        + 'set_debt_payment.',
      inputSchema: {
        accountId: Id.describe('A credit or loan account from list_accounts.'),
        interestRate: aprRate.optional(),
        minPayment: moneyAmount.optional(),
        plannedPayment: moneyAmount.optional(),
        includeInPaydown: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    run('update_paydown_settings', ctx, async (args) => {
      const { accountId, ...patch } = args;
      if (Object.values(patch).every((v) => v === undefined)) throw userError('Pass at least one setting to change.');
      const account = await requireAccount(userId, accountId);
      if (account.type !== 'credit' && account.type !== 'loan') {
        throw userError('Paydown settings apply to credit and loan accounts only.');
      }
      const nextMinimum = patch.minPayment ?? account.minPayment;
      const nextPlanned = patch.plannedPayment ?? account.plannedPayment;
      if (patch.minPayment !== undefined || patch.plannedPayment !== undefined) {
        if (nextMinimum <= 0) throw userError('Credit and loan accounts require a minimum payment greater than 0');
        if (nextPlanned > 0 && nextPlanned < nextMinimum) throw userError('Planned payment must be at least the minimum payment');
      }
      await editAccountPaydown(userId, accountId, patch);
      return { account: describeAccount(await requireAccount(userId, accountId)) };
    }, { audit: true }),
  );

  // ---- Accounts -------------------------------------------------------------

  defineTool(
    server,
    'add_account',
    {
      title: 'Add a manual account',
      description:
        'Add an account Cura does not sync, like "Add account" on the Accounts page. balance is a positive '
        + 'magnitude; for credit and loan accounts it is the amount owed. Set APR and payments with '
        + 'update_paydown_settings.',
      inputSchema: {
        name: z.string().trim().min(1).max(120),
        type: AccountType,
        balance: moneyAmount,
        institution: z.string().trim().max(120).optional(),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    run('add_account', ctx, async (args) => {
      const account = await addAccount(userId, {
        name: args.name,
        type: args.type,
        balance: args.balance,
        institution: args.institution || undefined,
        interestRate: 0,
        minPayment: 0,
        plannedPayment: 0,
        includeInPaydown: true,
        hidden: false,
        alias: undefined,
      });
      return { account: describeAccount(account) };
    }, { audit: true }),
  );

  defineTool(
    server,
    'update_account',
    {
      title: 'Edit an account',
      description:
        'Change an account\'s display name (alias), type, or balance, like "Edit account" on the Accounts page. '
        + 'Alias and type survive bank syncs; pass alias as null to go back to the bank\'s name. A synced balance is '
        + 'overwritten by the next sync. Changing an account to investment removes its bank-imported transactions; '
        + 'confirm with the user first.',
      inputSchema: {
        accountId: Id,
        alias: z.string().trim().max(120).nullable().optional(),
        type: AccountType.optional(),
        balance: moneyAmount.optional(),
      },
      annotations: WRITE,
    },
    run('update_account', ctx, async (args) => {
      const { accountId, ...patch } = args;
      if (Object.values(patch).every((v) => v === undefined)) throw userError('Pass at least one field to change.');
      await requireAccount(userId, accountId);
      await editAccount(userId, accountId, {
        // An empty alias clears it back to the bank's name, as in the editor.
        ...(patch.alias !== undefined ? { alias: patch.alias ?? '' } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.balance !== undefined ? { balance: patch.balance } : {}),
      });
      return { account: describeAccount(await requireAccount(userId, accountId)) };
    }, { audit: true }),
  );

  defineTool(
    server,
    'set_account_hidden',
    {
      title: 'Hide or unhide an account',
      description:
        'Hide an account from balances, reports, and budgets and pause its bank sync, or unhide it, like the '
        + 'Accounts page. Its transactions are kept.',
      inputSchema: { accountId: Id, hidden: z.boolean() },
      annotations: WRITE,
    },
    run('set_account_hidden', ctx, async ({ accountId, hidden }) => {
      await requireAccount(userId, accountId);
      await setAccountHidden(userId, accountId, hidden);
      return { account: describeAccount(await requireAccount(userId, accountId)) };
    }, { audit: true }),
  );

  defineTool(
    server,
    'delete_account',
    {
      title: 'Delete a manual account',
      description:
        'Delete a manual account, like the Accounts page. Its transactions are kept, goals tracking it are detached, '
        + 'and its Pay down goals sub-category and planned payments are removed. Bank-synced accounts cannot be '
        + 'deleted; hide them with set_account_hidden. Confirm with the user first.',
      inputSchema: { accountId: Id },
      annotations: DESTRUCTIVE,
    },
    run('delete_account', ctx, async ({ accountId }) => {
      const account = await requireAccount(userId, accountId);
      const result = await deleteAccount(userId, accountId);
      if (result === 'simplefin_forbidden') {
        throw userError('Bank-synced accounts cannot be deleted. Hide the account with set_account_hidden instead.', 409);
      }
      return { deleted: describeAccount(account) };
    }, { audit: true }),
  );

  defineTool(
    server,
    'sync_bank_accounts',
    {
      title: 'Sync bank accounts',
      description:
        'Pull the latest balances and transactions from the connected bank feed (SimpleFIN), like "Sync now" on the '
        + 'Accounts page. New transactions may land in list_pending_reviews.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run('sync_bank_accounts', ctx, async () => {
      if (!(await getSetting(userId, 'simplefin_access_url'))) {
        throw userError('No bank feed is connected. The user connects SimpleFIN on the Accounts page.', 409);
      }
      try {
        const result = await syncSimpleFinToDatabase(userId);
        return { ...result, pendingReviews: await pendingReviewCount(userId) };
      } catch (err) {
        // Same failure record and message as the Accounts page's "Sync now".
        const failure = publicSimpleFinError(err);
        await setSetting(userId, 'simplefin_last_error', failure.message);
        logger.warn({ code: failure.code, userId, tokenId: ctx.tokenId }, 'mcp: simplefin sync failed');
        throw userError(failure.message, 409);
      }
    }, { audit: true }),
  );

  // ---- Categories -----------------------------------------------------------

  defineTool(
    server,
    'create_category',
    {
      title: 'Create a category',
      description: 'Add a main category, like the Categories page. Add sub-categories to it with create_subcategory.',
      inputSchema: {
        name: MainCategoryName,
        type: TxType,
      },
      annotations: WRITE,
    },
    run('create_category', ctx, async ({ name, type }) => {
      const category = await addMainCategory(userId, name, type);
      return { category: { id: category.id, name: category.name, type: category.type } };
    }, { audit: true }),
  );

  defineTool(
    server,
    'create_subcategory',
    {
      title: 'Create a sub-category',
      description:
        'Add a sub-category under a main category. It appears on the Budget page with nothing planned; set an amount '
        + 'with set_budget.',
      inputSchema: {
        categoryId: Id.describe('Main category id from list_categories.'),
        name: z.string().trim().min(1).max(120),
      },
      annotations: WRITE,
    },
    run('create_subcategory', ctx, async ({ categoryId, name }) => {
      const parent = (await getAllCategories(userId)).find((c) => c.id === categoryId);
      if (!parent) throw userError(`No category with id ${categoryId}. Call list_categories.`, 404);
      const sub = await addSubCategory(userId, categoryId, name, 0);
      return { category: parent.name, subCategory: { id: sub.id, name: sub.name } };
    }, { audit: true }),
  );

  defineTool(
    server,
    'rename_category',
    {
      title: 'Rename a category',
      description:
        'Rename a main category, like the Categories page. Its transactions, splits, and rules follow the new name. '
        + 'Pay down goals cannot be renamed.',
      inputSchema: { categoryId: Id, name: MainCategoryName },
      annotations: WRITE,
    },
    run('rename_category', ctx, async ({ categoryId, name }) => {
      const main = requireMainCategory(await getAllCategories(userId), categoryId);
      await editMainCategory(userId, categoryId, name);
      return { category: { id: main.id, previousName: main.name, name, type: main.type } };
    }, { audit: true }),
  );

  defineTool(
    server,
    'rename_subcategory',
    {
      title: 'Rename a sub-category',
      description:
        'Rename a sub-category, like the Categories page. Its transactions, splits, rules, and budgets follow the new '
        + 'name. Pay down goals sub-categories follow their account names; rename the account instead.',
      inputSchema: { subCategoryId: Id, name: z.string().trim().min(1).max(120) },
      annotations: WRITE,
    },
    run('rename_subcategory', ctx, async ({ subCategoryId, name }) => {
      const { main, sub } = findSubCategory(await getAllCategories(userId), subCategoryId);
      await editSubCategory(userId, main.id, sub.id, name);
      return { category: main.name, subCategory: { id: sub.id, previousName: sub.name, name } };
    }, { audit: true }),
  );

  defineTool(
    server,
    'delete_category',
    {
      title: 'Delete a category',
      description:
        'Delete a main category and its sub-categories, like the Categories page. Rules that assign to it are deleted; '
        + 'its transactions keep their category text but are no longer linked to a category. Confirm with the user '
        + 'first.',
      inputSchema: { categoryId: Id },
      annotations: DESTRUCTIVE,
    },
    run('delete_category', ctx, async ({ categoryId }) => {
      const main = requireMainCategory(await getAllCategories(userId), categoryId);
      await deleteMainCategory(userId, categoryId);
      return { deleted: { id: main.id, name: main.name, type: main.type, subCategories: main.subCategories.map((s) => s.name) } };
    }, { audit: true }),
  );

  defineTool(
    server,
    'delete_subcategory',
    {
      title: 'Delete a sub-category',
      description:
        'Delete a sub-category, like the Categories page. Rules that assign to it are deleted; its transactions keep '
        + 'their sub-category text but are no longer linked to it. Confirm with the user first.',
      inputSchema: { subCategoryId: Id },
      annotations: DESTRUCTIVE,
    },
    run('delete_subcategory', ctx, async ({ subCategoryId }) => {
      const { main, sub } = findSubCategory(await getAllCategories(userId), subCategoryId);
      await deleteSubCategory(userId, main.id, sub.id);
      return { deleted: { category: main.name, subCategory: { id: sub.id, name: sub.name } } };
    }, { audit: true }),
  );

  defineTool(
    server,
    'reorder_categories',
    {
      title: 'Reorder categories',
      description:
        'Set the order of main categories on the Categories and Budget pages, like dragging them. List category ids '
        + 'top first; categories left out keep their position.',
      inputSchema: { orderedIds: z.array(Id).min(1).max(500) },
      annotations: WRITE,
    },
    run('reorder_categories', ctx, async ({ orderedIds }) => {
      const categories = await getAllCategories(userId);
      const known = new Set(categories.map((c) => c.id));
      const unknown = orderedIds.filter((id) => !known.has(id));
      if (unknown.length > 0) throw userError(`Unknown category ids: ${unknown.join(', ')}. Call list_categories.`, 404);
      await reorderMainCategories(userId, orderedIds);
      const after = await getAllCategories(userId);
      return { categories: after.map((c) => ({ id: c.id, name: c.name, type: c.type })) };
    }, { audit: true }),
  );

  // ---- Goals ----------------------------------------------------------------

  defineTool(
    server,
    'create_goal',
    {
      title: 'Create a savings goal',
      description:
        'Add a savings goal that tracks an account\'s balance toward a target, like the Goals page. startingValue is '
        + 'the balance progress is measured from (default 0).',
      inputSchema: {
        name: z.string().trim().min(1).max(120),
        target: positiveMoneyAmount,
        startingValue: moneyAmount.optional(),
        accountId: Id.describe('Account the goal tracks (list_accounts).'),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    run('create_goal', ctx, async (args) => {
      await requireAccount(userId, args.accountId);
      const goal = await addGoal(userId, { ...args, startingValue: args.startingValue ?? 0 });
      return { goal: await requireGoal(userId, goal.id) };
    }, { audit: true }),
  );

  defineTool(
    server,
    'update_goal',
    {
      title: 'Edit a savings goal',
      description:
        'Change a goal\'s name, target, starting value, or tracked account, like the Goals page. Only the fields given '
        + 'change; pass accountId as null to detach the account.',
      inputSchema: {
        goalId: Id,
        name: z.string().trim().min(1).max(120).optional(),
        target: positiveMoneyAmount.optional(),
        startingValue: moneyAmount.optional(),
        accountId: Id.nullable().optional(),
      },
      annotations: WRITE,
    },
    run('update_goal', ctx, async ({ goalId, ...patch }) => {
      await requireGoal(userId, goalId);
      if (patch.accountId) await requireAccount(userId, patch.accountId);
      await editGoal(userId, goalId, patch);
      return { goal: await requireGoal(userId, goalId) };
    }, { audit: true }),
  );

  defineTool(
    server,
    'delete_goal',
    {
      title: 'Delete a savings goal',
      description: 'Delete a savings goal. The account it tracked is not changed. Confirm with the user first.',
      inputSchema: { goalId: Id },
      annotations: DESTRUCTIVE,
    },
    run('delete_goal', ctx, async ({ goalId }) => {
      const goal = await requireGoal(userId, goalId);
      await deleteGoal(userId, goalId);
      return { deleted: goal };
    }, { audit: true }),
  );

  // ---- Recurring charges ----------------------------------------------------

  defineTool(
    server,
    'set_recurring_charge',
    {
      title: 'Mark a charge as recurring',
      description:
        'Mark a merchant\'s charges on an account as recurring and set how often they repeat (weekly, monthly, or '
        + 'yearly), like the recurring picker on the Transactions page. Also changes the frequency of a charge already '
        + 'in list_recurring_charges, including a manual entry. Identify it by transactionId (any of its '
        + 'transactions), by id (a manual entry), or by merchant with accountId or account. The amount, account, '
        + 'category, and next date come from the latest matching transaction. Marking a charge the user removed '
        + 'brings it back.',
      inputSchema: {
        frequency: Frequency,
        transactionId: Id.optional().describe('From search_transactions.'),
        id: Id.optional().describe('Manual entry id from list_recurring_charges.'),
        merchant: z.string().trim().min(1).max(500).optional(),
        accountId: Id.optional(),
        account: z.string().trim().min(1).max(120).optional().describe('Account name, when accountId is unknown.'),
      },
      annotations: WRITE,
    },
    run('set_recurring_charge', ctx, async (args) => {
      const given = [args.transactionId, args.id, args.merchant].filter((v) => v !== undefined).length;
      if (given !== 1) throw userError('Pass exactly one of transactionId, id, or merchant.');

      const manualId = args.id
        ?? (args.merchant
          ? matchCharges(await loadActiveRecurringCharges(userId), { ...args, merchant: args.merchant })
            .find((c) => c.manual)?.id
          : undefined);
      if (manualId) {
        const entry = (await listManualRecurring(userId)).find((item) => item.id === manualId);
        if (!entry) throw userError(`No manual recurring charge with id ${manualId}. Call list_recurring_charges.`, 404);
        const { id: _id, ...input } = entry;
        const updated = await updateManualRecurring(userId, manualId, { ...input, frequency: args.frequency });
        if (!updated) throw userError(`No manual recurring charge with id ${manualId}.`, 404);
        const charge = (await loadActiveRecurringCharges(userId)).find((c) => c.id === manualId);
        return { status: entry.frequency === args.frequency ? 'unchanged' : 'updated', charge: charge ? describeCharge(charge) : updated };
      }

      const latest = args.transactionId
        ? await getRecurringTransactionMetadata(userId, args.transactionId)
        : await resolveRecurringTransactionMetadata(userId, {
          merchant: args.merchant!,
          account: args.account,
          accountId: args.accountId,
          type: 'expense',
        });
      if (!latest) {
        throw userError(
          args.transactionId
            ? `No transaction with id ${args.transactionId}. Use search_transactions to find ids.`
            : `No expense transactions from "${args.merchant}"${args.account || args.accountId ? ' on that account' : ''}. `
              + 'Use add_manual_recurring_charge for a charge that has not posted yet.',
          404,
        );
      }
      await markRecurring(userId, {
        merchant: latest.merchant,
        amount: latest.amount,
        account: latest.account,
        accountId: latest.accountId,
        frequency: args.frequency,
        lastDate: latest.lastDate,
        category: latest.category,
      });
      const [charge] = matchCharges(await loadActiveRecurringCharges(userId), {
        merchant: latest.merchant,
        accountId: latest.accountId,
        account: latest.accountId ? undefined : latest.account,
      });
      return { status: 'marked', charge: charge ? describeCharge(charge) : null };
    }, { audit: true }),
  );

  defineTool(
    server,
    'remove_recurring_charge',
    {
      title: 'Remove a recurring charge',
      description:
        'Stop treating a charge as recurring, like "None" on the Transactions page or removing it on the Recurring '
        + 'page. Detected and marked charges are dismissed so detection does not bring them back (set_recurring_charge '
        + 'restores one); manual entries are deleted. Identify it by id (manual entry) or merchant with accountId or '
        + 'account, as in list_recurring_charges. Confirm with the user first.',
      inputSchema: {
        id: Id.optional().describe('Manual entry id from list_recurring_charges.'),
        merchant: z.string().trim().min(1).max(500).optional(),
        accountId: Id.optional(),
        account: z.string().trim().min(1).max(120).optional(),
      },
      annotations: DESTRUCTIVE,
    },
    run('remove_recurring_charge', ctx, async (args) => {
      if ((args.id === undefined) === (args.merchant === undefined)) throw userError('Pass either id or merchant.');
      const charges = await loadActiveRecurringCharges(userId);
      const charge = args.id
        ? charges.find((c) => c.id === args.id)
        : requireOneCharge(matchCharges(charges, { ...args, merchant: args.merchant! }), args.merchant!);
      if (args.id && !(await listManualRecurring(userId)).some((item) => item.id === args.id)) {
        throw userError(`No manual recurring charge with id ${args.id}. Call list_recurring_charges.`, 404);
      }
      if (args.id || charge?.manual) {
        const id = args.id ?? charge!.id!;
        await deleteManualRecurring(userId, id);
        return { status: 'deleted', removed: charge ? describeCharge(charge) : { id } };
      }
      await dismissRecurring(userId, charge!.merchant, charge!.amount, charge!.account, charge!.accountId);
      return { status: 'dismissed', removed: describeCharge(charge!) };
    }, { audit: true }),
  );

  defineTool(
    server,
    'add_manual_recurring_charge',
    {
      title: 'Add a manual recurring charge',
      description:
        'Add a subscription or bill that has no transactions in Cura yet (it has not posted, or the account is not '
        + 'synced), like "Add" on the Recurring page. anchorDate is any one real or expected charge date; the next '
        + 'due date is projected from it. For a charge that already has transactions, use set_recurring_charge.',
      inputSchema: {
        merchant: z.string().trim().min(1).max(120),
        amount: moneyAmount.describe('Charge amount, positive.'),
        frequency: Frequency,
        account: z.string().trim().min(1).max(120).describe('Account it is paid from.'),
        category: z.string().trim().min(1).max(120),
        anchorDate: CalendarDate.describe('YYYY-MM-DD of one occurrence.'),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    run('add_manual_recurring_charge', ctx, async (args) => {
      const parsed = manualRecurringInputSchema.safeParse(args);
      if (!parsed.success) throw userError(parsed.error.issues[0]?.message ?? 'invalid input');
      const entry = await addManualRecurring(userId, parsed.data);
      const charge = (await loadActiveRecurringCharges(userId)).find((c) => c.id === entry.id);
      return {
        charge: charge ? describeCharge(charge) : entry,
        ...(charge ? {} : { note: 'A detected charge for this merchant and account already exists, so it is shown instead.' }),
      };
    }, { audit: true }),
  );

  defineTool(
    server,
    'update_manual_recurring_charge',
    {
      title: 'Edit a manual recurring charge',
      description:
        'Change a manual entry from list_recurring_charges (one with manual: true), like editing it on the Recurring '
        + 'page. Only the fields given change.',
      inputSchema: {
        id: Id,
        merchant: z.string().trim().min(1).max(120).optional(),
        amount: moneyAmount.optional(),
        frequency: Frequency.optional(),
        account: z.string().trim().min(1).max(120).optional(),
        category: z.string().trim().min(1).max(120).optional(),
        anchorDate: CalendarDate.optional(),
      },
      annotations: WRITE,
    },
    run('update_manual_recurring_charge', ctx, async ({ id, ...changes }) => {
      const entry = (await listManualRecurring(userId)).find((item) => item.id === id);
      if (!entry) throw userError(`No manual recurring charge with id ${id}. Call list_recurring_charges.`, 404);
      const { id: _id, ...current } = entry;
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      const parsed = manualRecurringInputSchema.safeParse({ ...current, ...defined });
      if (!parsed.success) throw userError(parsed.error.issues[0]?.message ?? 'invalid input');
      const updated = await updateManualRecurring(userId, id, parsed.data);
      if (!updated) throw userError(`No manual recurring charge with id ${id}.`, 404);
      const charge = (await loadActiveRecurringCharges(userId)).find((c) => c.id === id);
      return { charge: charge ? describeCharge(charge) : updated };
    }, { audit: true }),
  );
}
