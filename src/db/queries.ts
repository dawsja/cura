/**
 * Data layer. Every function takes `userId` as the first argument and
 * filters by `user_id` on every read/write. The guard middleware on the
 * root app puts an authenticated user on the Hono context; routes call
 * `userId(c)` from `@/lib/tenant` and pass it in.
 *
 * Functions are organized by resource: accounts, categories, sub-categories,
 * transactions, goals, monthly_budgets, settings.
 */
export * from './queries/types';
export * from './queries/first-run';
export * from './queries/accounts';
export * from './queries/categories';
export * from './queries/transactions';
export * from './queries/reviews';
export * from './queries/settings';
export * from './queries/paydown';
export * from './queries/goals';
export * from './queries/rules';
export * from './queries/admin';
export * from './queries/reports';
export * from './queries/recurring';
