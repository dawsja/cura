/**
 * MCP tools that change data, registered only for tokens with the
 * `finance:write` scope. Each one runs the same query helpers and checks as
 * the matching web app action, so an agent cannot do anything the UI would
 * refuse:
 *
 *   Transactions page   categorize_transaction (category picker, plus the
 *                       "Create scoped rule" follow-up), bulk_categorize_
 *                       transactions (Budget drill-down "Move").
 *   Review modal        review_transaction, accept_all_reviews.
 *   Rules page          create_rule, create_rule_from_transaction,
 *                       update_rule, delete_rule, run_rules.
 *   Budget page         set_budget (+ "Apply to future months"),
 *                       set_debt_payment, save_debt_plan_to_budget.
 *   Categories page     create_category, create_subcategory.
 *
 * As in the UI, changing a transaction never creates or edits a rule by
 * itself, and a new rule only touches existing transactions when it is run.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '@/db/client';
import {
  addMainCategory,
  addSubCategory,
  applyAllRulesToMatchingTransactions,
  applyRuleToAllMatchingTransactions,
  bulkAssignTransactions,
  createRule,
  createRuleFromTransaction,
  deleteRule,
  editRule,
  editTransaction,
  getAccount,
  getAllCategories,
  getTransactionAssignment,
  listRules,
  markTransactionReviewed,
  pendingReviewCount,
  skipAllPendingReviews,
  type MainCategory,
  type Rule,
  type RuleFromTransactionResult,
  type TransactionType,
} from '@/db/queries';
import { MainCategoryName } from '@/lib/category-name';
import { moneyAmount } from '@/lib/money';
import { applyBudgetToFutureMonths, saveDebtPlanToBudget, setMonthlyBudget, setPlannedDebtPayment } from '@/services/budget';
import { buildBudgetView } from './budget-view';
import {
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
      + 'Edit the split in the web app.',
      409,
    );
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
}
