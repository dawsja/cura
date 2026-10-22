/**
 * MCP tool surface over one user's finances: read tools for every token,
 * plus the write tools in `./write-tools.ts` for tokens with the write scope.
 *
 * A fresh server is built per request (the HTTP transport is stateless) and
 * closes over the authenticated `userId`, so every tool is tenant-scoped by
 * construction. Money is reported in dollars (major units), matching the
 * REST API; every result carries the user's display `currency` code.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getAllAccounts,
  getAllCategories,
  getAllGoals,
  getCashFlowSeries,
  getDashboardActivity,
  getLiabilityAccounts,
  getNetWorthSeries,
  getSetting,
  getSpendingByCategory,
  getSpendingCategoryTrends,
  getSpendingPace,
  getTopMerchants,
  listReviewQueue,
  listRules,
  listTransactions,
  netWorthContributionForAccount,
  pendingReviewCount,
  type TransactionFilters,
} from '@/db/queries';
import { DISPLAY_CURRENCY_KEY, resolveCurrency } from '@/lib/currency';
import { centsToDollars, dollarsToCents, moneyAmount } from '@/lib/money';
import { emptyProjection, projectPaydown, toPaydownAccount, type PaydownParams } from '@/lib/paydown';
import { ReportRange, resolveReportRange } from '@/lib/report-range';
import { loadActiveRecurringCharges, recurringSchedule } from '@/services/recurring';
import { buildBudgetView } from './budget-view';
import { CalendarDate, READ_ONLY, YearMonth, currentYearMonth, defineTool, run, type McpContext } from './tool-kit';
import { registerWriteTools } from './write-tools';

const SERVER_VERSION = '1.1.0';

const READ_INSTRUCTIONS =
  'Access to one Cura Money user\'s personal finances. Amounts are in major currency units '
  + '(e.g. dollars) of the `currency` field. Transaction types are income, expense, and transfer; transfers '
  + 'move money between the user\'s own accounts and are excluded from income/expense totals. Account '
  + 'balances are reported as positive magnitudes; credit and loan accounts are liabilities.';

const WRITE_INSTRUCTIONS =
  ' This token can also make changes, through the same rules as the web app. Categories are always a main '
  + 'category plus one of its sub-categories (see list_categories), and the transaction type must match the '
  + 'category\'s type except for "Pay down goals". Changing a transaction\'s category never creates or edits '
  + 'a rule by itself; pass createRule or call create_rule_from_transaction when the user wants future imports '
  + 'handled the same way. Rules only change existing transactions when run with run_rules. Prefer '
  + 'review_transaction for items from list_pending_reviews. Budget amounts apply to one month unless '
  + 'applyToFutureMonths is true. Confirm with the user before bulk changes or deleting a rule.';

export function createFinanceMcpServer(ctx: McpContext): McpServer {
  const { userId } = ctx;
  const server = new McpServer(
    { name: 'cura', title: 'Cura Money', version: SERVER_VERSION },
    { instructions: ctx.canWrite ? READ_INSTRUCTIONS + WRITE_INSTRUCTIONS : READ_INSTRUCTIONS },
  );
  const currency = async () => resolveCurrency(await getSetting(userId, DISPLAY_CURRENCY_KEY));

  defineTool(
    server,
    'get_financial_overview',
    {
      title: 'Financial overview',
      description:
        'Net worth, total assets and liabilities, last-30-day income/expense, and the number of transactions '
        + 'awaiting review. A good first call.',
      annotations: READ_ONLY,
    },
    run('get_financial_overview', ctx, async () => {
      const [accounts, activity, pendingReviews, cur, lastSync] = await Promise.all([
        getAllAccounts(userId),
        getDashboardActivity(userId),
        pendingReviewCount(userId),
        currency(),
        getSetting(userId, 'simplefin_last_sync'),
      ]);
      let assetsCents = 0;
      let liabilitiesCents = 0;
      for (const account of accounts) {
        const cents = Math.round(netWorthContributionForAccount(account.type, account.balance) * 100);
        if (cents >= 0) assetsCents += cents;
        else liabilitiesCents -= cents;
      }
      return {
        currency: cur,
        netWorth: centsToDollars(assetsCents - liabilitiesCents),
        totalAssets: centsToDollars(assetsCents),
        totalLiabilities: centsToDollars(liabilitiesCents),
        accountCount: accounts.length,
        last30Days: { income: activity.income, expense: activity.expense, transferCount: activity.transferCount },
        recentTransactions: activity.recent,
        transactionsAwaitingReview: pendingReviews,
        lastBankSync: lastSync || null,
      };
    }),
  );

  defineTool(
    server,
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'All accounts with type (checking, savings, credit, investment, loan, uncategorized), current balance, '
        + 'institution, and debt paydown settings. Hidden accounts are excluded unless includeHidden is true.',
      inputSchema: { includeHidden: z.boolean().optional().describe('Include accounts the user has hidden.') },
      annotations: READ_ONLY,
    },
    run('list_accounts', ctx, async ({ includeHidden }) => {
      const [accounts, cur] = await Promise.all([getAllAccounts(userId, { includeHidden }), currency()]);
      return {
        currency: cur,
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.alias || a.name,
          canonicalName: a.name,
          type: a.type,
          balance: a.balance,
          isLiability: a.type === 'credit' || a.type === 'loan',
          institution: a.institution ?? null,
          source: a.source,
          hidden: a.hidden,
          interestRate: a.interestRate,
          minPayment: a.minPayment,
          plannedPayment: a.plannedPayment,
        })),
      };
    }),
  );

  const SearchInput = {
    query: z.string().max(200).optional().describe('Free-text search across merchant, category, account, notes, and amount.'),
    fromDate: CalendarDate.optional().describe('Inclusive start date, YYYY-MM-DD.'),
    toDate: CalendarDate.optional().describe('Inclusive end date, YYYY-MM-DD.'),
    merchant: z.string().max(200).optional().describe('Exact merchant name.'),
    category: z.string().max(120).optional().describe('Main category name.'),
    subCategory: z.string().max(120).optional().describe('Sub-category name.'),
    types: z.array(z.enum(['income', 'expense', 'transfer'])).max(3).optional(),
    accountIds: z.array(z.string().min(1).max(200)).max(50).optional().describe('Account ids from list_accounts.'),
    minAmount: moneyAmount.optional().describe('Minimum absolute amount.'),
    maxAmount: moneyAmount.optional().describe('Maximum absolute amount.'),
    reviewed: z.boolean().optional().describe('Filter by whether the user has reviewed the transaction.'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size, default 25, max 100.'),
    offset: z.number().int().min(0).optional().describe('Rows to skip for pagination.'),
  };

  defineTool(
    server,
    'search_transactions',
    {
      title: 'Search transactions',
      description:
        'Search and filter the transaction ledger, newest first. Returns one page plus the total match count; '
        + 'use offset to paginate. Amounts are positive; `type` says whether money came in or went out.',
      inputSchema: SearchInput,
      annotations: READ_ONLY,
    },
    run('search_transactions', ctx, async (args) => {
      const filters: TransactionFilters = {
        q: args.query,
        fromDate: args.fromDate,
        toDate: args.toDate,
        merchant: args.merchant,
        category: args.category,
        subCategory: args.subCategory,
        types: args.types,
        accountIds: args.accountIds,
        minAmountCents: args.minAmount === undefined ? undefined : dollarsToCents(args.minAmount),
        maxAmountCents: args.maxAmount === undefined ? undefined : dollarsToCents(args.maxAmount),
        reviewed: args.reviewed,
      };
      const limit = args.limit ?? 25;
      const offset = args.offset ?? 0;
      const [page, cur] = await Promise.all([listTransactions(userId, { limit, offset, filters }), currency()]);
      return {
        currency: cur,
        total: page.total,
        limit,
        offset,
        transactions: page.rows.map((t) => ({
          id: t.id,
          date: t.date,
          merchant: t.merchant,
          amount: t.amount,
          type: t.type,
          category: t.category,
          subCategory: t.subCategory,
          account: t.account,
          accountId: t.accountId ?? null,
          notes: t.notes ?? null,
          // What the bank import said; scoped rules match on it.
          source: t.sourceClassificationTrusted
            ? { type: t.sourceType, category: t.sourceCategory, subCategory: t.sourceSubCategory ?? null }
            : null,
          splits: t.splits?.map((s) => ({
            amount: s.amount,
            type: s.type,
            category: s.category,
            subCategory: s.subCategory,
          })) ?? [],
        })),
      };
    }),
  );

  defineTool(
    server,
    'list_categories',
    {
      title: 'List categories',
      description:
        'Main categories (income, expense, transfer) with their sub-categories and default planned budget amounts. '
        + 'Transactions, rules, and budgets always use a main category plus one of its sub-categories.',
      annotations: READ_ONLY,
    },
    run('list_categories', ctx, async () => {
      const [categories, cur] = await Promise.all([getAllCategories(userId), currency()]);
      return {
        currency: cur,
        categories: categories.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          subCategories: c.subCategories.map((s) => ({ id: s.id, name: s.name, defaultPlanned: s.planned })),
        })),
      };
    }),
  );

  defineTool(
    server,
    'get_budget',
    {
      title: 'Monthly budget',
      description:
        'The Budget page for a month: planned vs. actual for every income and expense sub-category (income as one '
        + 'group, one group per expense category), planned debt payments from Pay down, and the totals including '
        + 'Left to budget (planned income minus planned expenses and debt payments). Each line has the '
        + 'subCategoryId that set_budget takes. Defaults to the current month.',
      inputSchema: {
        month: YearMonth.optional().describe('YYYY-MM; defaults to the current month.'),
        hideUnbudgeted: z.boolean().optional().describe('Leave out lines with nothing planned and nothing spent, like the page toggle.'),
      },
      annotations: READ_ONLY,
    },
    run('get_budget', ctx, async ({ month, hideUnbudgeted }) => {
      const [view, cur] = await Promise.all([
        buildBudgetView(userId, month ?? currentYearMonth(), { hideUnbudgeted }),
        currency(),
      ]);
      return { currency: cur, ...view };
    }),
  );

  const ReportKind = z.enum([
    'cash_flow',
    'net_worth',
    'spending_by_category',
    'spending_trends',
    'spending_pace',
    'top_merchants',
  ]);

  defineTool(
    server,
    'get_report',
    {
      title: 'Financial report',
      description:
        'Pre-aggregated report series. cash_flow, net_worth, spending_trends, and top_merchants use `range` '
        + '(1m, 3m, 6m, 1y, all; default 6m). spending_by_category and spending_pace use `month` '
        + '(YYYY-MM; default current month). Transfers and hidden/investment accounts are excluded.',
      inputSchema: {
        report: ReportKind,
        range: ReportRange.optional(),
        month: YearMonth.optional(),
      },
      annotations: READ_ONLY,
    },
    run('get_report', ctx, async (args) => {
      const cur = await currency();
      if (args.report === 'spending_by_category' || args.report === 'spending_pace') {
        const month = args.month ?? currentYearMonth();
        const data = args.report === 'spending_by_category'
          ? await getSpendingByCategory(userId, month)
          : await getSpendingPace(userId, month);
        return { currency: cur, report: args.report, month, data };
      }
      const range = args.range ?? '6m';
      const { fromDate, toDate } = await resolveReportRange(userId, range);
      const data = args.report === 'cash_flow'
        ? await getCashFlowSeries(userId, fromDate, toDate)
        : args.report === 'net_worth'
          ? await getNetWorthSeries(userId, fromDate, toDate)
          : args.report === 'spending_trends'
            ? await getSpendingCategoryTrends(userId, fromDate, toDate)
            : await getTopMerchants(userId, fromDate, toDate);
      return { currency: cur, report: args.report, range, fromDate, toDate, data };
    }),
  );

  defineTool(
    server,
    'list_goals',
    {
      title: 'Savings goals',
      description: 'Savings goals with target, starting value, and the live balance of the account each goal tracks.',
      annotations: READ_ONLY,
    },
    run('list_goals', ctx, async () => {
      const [goals, cur] = await Promise.all([getAllGoals(userId), currency()]);
      return { currency: cur, goals };
    }),
  );

  defineTool(
    server,
    'list_recurring_charges',
    {
      title: 'Recurring charges',
      description:
        'Detected and user-marked recurring charges (subscriptions, bills) with frequency, typical amount, '
        + 'and the next expected date.',
      annotations: READ_ONLY,
    },
    run('list_recurring_charges', ctx, async () => {
      const [charges, cur] = await Promise.all([loadActiveRecurringCharges(userId), currency()]);
      return {
        currency: cur,
        charges: charges.map((charge) => ({ ...charge, ...recurringSchedule(charge.lastDate, charge.frequency) })),
      };
    }),
  );

  defineTool(
    server,
    'get_debt_paydown_projection',
    {
      title: 'Debt paydown projection',
      description:
        'Month-by-month payoff projection for credit and loan accounts included in paydown. `planned` uses the '
        + 'user\'s planned payments; `avalanche` (highest APR first) and `snowball` (smallest balance first) '
        + 'apply optional extra payments. Pure simulation; nothing is saved.',
      inputSchema: {
        method: z.enum(['planned', 'avalanche', 'snowball']).optional().describe('Default planned.'),
        monthlyExtra: moneyAmount.optional().describe('Extra amount paid every month.'),
        oneTimeExtra: moneyAmount.optional().describe('One-time extra payment in the first month.'),
      },
      annotations: READ_ONLY,
    },
    run('get_debt_paydown_projection', ctx, async (args) => {
      const params: PaydownParams = {
        method: args.method ?? 'planned',
        monthlyExtra: args.monthlyExtra ?? 0,
        oneTimeExtra: args.oneTimeExtra ?? 0,
      };
      const [accounts, cur] = await Promise.all([getLiabilityAccounts(userId), currency()]);
      const projection = accounts.length === 0
        ? emptyProjection(params.method, params)
        : projectPaydown(accounts.map(toPaydownAccount), params);
      return { currency: cur, projection };
    }),
  );

  defineTool(
    server,
    'list_rules',
    {
      title: 'Categorization rules',
      description:
        'Rules that categorize imported transactions. A rule matches the merchant (exact or prefix, ignoring case '
        + 'and spacing) and, when set, the account and the type/category the bank import assigned; the most specific '
        + 'match wins. `version` is needed to update a rule.',
      annotations: READ_ONLY,
    },
    run('list_rules', ctx, async () => {
      const [rules, accounts] = await Promise.all([listRules(userId), getAllAccounts(userId, { includeHidden: true })]);
      const accountName = new Map(accounts.map((a) => [a.id, a.alias || a.name]));
      return {
        rules: rules.map((r) => ({
          id: r.id,
          version: r.version,
          matchValue: r.matchValue,
          accountId: r.accountId ?? null,
          account: r.accountId ? accountName.get(r.accountId) ?? null : null,
          sourceType: r.sourceType ?? null,
          sourceCategory: r.sourceCategory ?? null,
          sourceSubCategory: r.sourceSubCategory ?? null,
          category: r.category,
          subCategory: r.subCategory ?? null,
          type: r.type ?? null,
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    }),
  );

  defineTool(
    server,
    'list_pending_reviews',
    {
      title: 'Transactions awaiting review',
      description: 'Imported transactions the user has not yet reviewed or confirmed the category of.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe('Default 50.') },
      annotations: READ_ONLY,
    },
    run('list_pending_reviews', ctx, async ({ limit }) => {
      const [transactions, total, cur] = await Promise.all([
        listReviewQueue(userId, { limit: limit ?? 50 }),
        pendingReviewCount(userId),
        currency(),
      ]);
      return { currency: cur, total, transactions };
    }),
  );

  if (ctx.canWrite) registerWriteTools(server, ctx);
  return server;
}
