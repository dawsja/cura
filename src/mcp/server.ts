/**
 * Read-only MCP tool surface over one user's finances.
 *
 * A fresh server is built per request (the HTTP transport is stateless) and
 * closes over the authenticated `userId`, so every tool is tenant-scoped by
 * construction. Money is reported in dollars (major units), matching the
 * REST API; every result carries the user's display `currency` code.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  getAllAccounts,
  getAllCategories,
  getAllGoals,
  getBudgetActivity,
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
  listTransactions,
  netWorthContributionForAccount,
  pendingReviewCount,
  type TransactionFilters,
} from '@/db/queries';
import { latestBudgetsUpTo } from '@/db/budget-repository';
import { DISPLAY_CURRENCY_KEY, resolveCurrency } from '@/lib/currency';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { centsToDollars, dollarsToCents, moneyAmount } from '@/lib/money';
import { emptyProjection, projectPaydown, toPaydownAccount, type PaydownParams } from '@/lib/paydown';
import { ReportRange, resolveReportRange } from '@/lib/report-range';
import { loadActiveRecurringCharges, recurringSchedule } from '@/services/recurring';

const SERVER_VERSION = '1.0.0';
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');
const CalendarDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD');

/** Current ledger month in the deployment timezone. */
function currentYearMonth(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.TZ, year: 'numeric', month: '2-digit' })
    .format(now)
    .slice(0, 7);
}

function toolResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Data-layer errors carrying a 4xx `status` are user-facing (bad filter,
 * unknown id); anything else is logged and reported generically.
 */
function run<A>(name: string, userId: string, fn: (args: A) => Promise<Record<string, unknown>>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return toolResult(await fn(args));
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return toolError((err as Error).message || 'request failed');
      }
      logger.error({ err, tool: name, userId }, 'mcp: tool failed');
      return toolError('internal error while running this tool');
    }
  };
}

interface ToolConfig<S extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema?: S;
  annotations: ToolAnnotations;
}

type RegisterTool = (
  name: string,
  config: ToolConfig<z.ZodRawShape>,
  handler: (args: unknown) => Promise<CallToolResult>,
) => void;

/**
 * Typed front for `McpServer.registerTool`. The SDK's own signature infers
 * across zod v3 and v4 shapes, which makes `tsc` exhaust memory with this
 * many tools; inferring from our zod v3 shape here keeps checking cheap.
 * The SDK still validates arguments against `inputSchema` at runtime.
 */
function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: ToolConfig<S>,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  const register = server.registerTool.bind(server) as unknown as RegisterTool;
  register(name, config, (args) => handler(args as z.infer<z.ZodObject<S>>));
}

export function createFinanceMcpServer(userId: string): McpServer {
  const server = new McpServer(
    { name: 'cura', title: 'Cura Money', version: SERVER_VERSION },
    {
      instructions:
        'Read-only access to one Cura Money user\'s personal finances. Amounts are in major currency units '
        + '(e.g. dollars) of the `currency` field. Transaction types are income, expense, and transfer; transfers '
        + 'move money between the user\'s own accounts and are excluded from income/expense totals. Account '
        + 'balances are reported as positive magnitudes; credit and loan accounts are liabilities.',
    },
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
    run('get_financial_overview', userId, async () => {
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
    run('list_accounts', userId, async ({ includeHidden }) => {
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
    run('search_transactions', userId, async (args) => {
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
      description: 'Main categories (income, expense, transfer) with their sub-categories and default planned budget amounts.',
      annotations: READ_ONLY,
    },
    run('list_categories', userId, async () => {
      const [categories, cur] = await Promise.all([getAllCategories(userId), currency()]);
      return {
        currency: cur,
        categories: categories.map((c) => ({
          name: c.name,
          type: c.type,
          subCategories: c.subCategories.map((s) => ({ name: s.name, defaultPlanned: s.planned })),
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
        'Planned vs. actual for every income and expense sub-category in a month, with totals. '
        + 'Defaults to the current month.',
      inputSchema: { month: YearMonth.optional().describe('YYYY-MM; defaults to the current month.') },
      annotations: READ_ONLY,
    },
    run('get_budget', userId, async ({ month }) => {
      const ym = month ?? currentYearMonth();
      const [categories, overrides, activity, cur] = await Promise.all([
        getAllCategories(userId),
        latestBudgetsUpTo(userId, ym),
        getBudgetActivity(userId, ym),
        currency(),
      ]);
      const actualByKey = new Map(activity.rows.map((r) => [`${r.category}\u0000${r.subCategory}`, r.actual]));
      const totals = { income: { planned: 0, actual: 0 }, expense: { planned: 0, actual: 0 } };
      const lines: Array<{ category: string; subCategory: string; type: 'income' | 'expense'; planned: number; actual: number; remaining: number }> = [];
      for (const c of categories) {
        // Transfers are budget-neutral moves between the user's own accounts.
        if (c.type === 'transfer') continue;
        for (const s of c.subCategories) {
          const plannedCents = dollarsToCents(overrides.get(s.id) ?? s.planned);
          const actualCents = dollarsToCents(actualByKey.get(`${c.name}\u0000${s.name}`) ?? 0);
          totals[c.type].planned += plannedCents;
          totals[c.type].actual += actualCents;
          lines.push({
            category: c.name,
            subCategory: s.name,
            type: c.type,
            planned: centsToDollars(plannedCents),
            actual: centsToDollars(actualCents),
            remaining: centsToDollars(plannedCents - actualCents),
          });
        }
      }
      return {
        currency: cur,
        month: ym,
        totals: {
          income: { planned: centsToDollars(totals.income.planned), actual: centsToDollars(totals.income.actual) },
          expense: { planned: centsToDollars(totals.expense.planned), actual: centsToDollars(totals.expense.actual) },
        },
        lines,
      };
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
    run('get_report', userId, async (args) => {
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
    run('list_goals', userId, async () => {
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
    run('list_recurring_charges', userId, async () => {
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
    run('get_debt_paydown_projection', userId, async (args) => {
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
    'list_pending_reviews',
    {
      title: 'Transactions awaiting review',
      description: 'Imported transactions the user has not yet reviewed or confirmed the category of.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe('Default 50.') },
      annotations: READ_ONLY,
    },
    run('list_pending_reviews', userId, async ({ limit }) => {
      const [transactions, total, cur] = await Promise.all([
        listReviewQueue(userId, { limit: limit ?? 50 }),
        pendingReviewCount(userId),
        currency(),
      ]);
      return { currency: cur, total, transactions };
    }),
  );

  return server;
}
