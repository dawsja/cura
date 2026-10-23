import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../client';
import { categories } from '../schema/categories';
import { subCategories } from '../schema/sub_categories';
import { transactions } from '../schema/transactions';
import { rules } from '../schema/rules';
import { normalizeMerchant, pickBestRuleMatch } from '@/lib/merchant-match';
import { resolveCategoryAssignment, uniqueAssignmentsByName } from './category-assignments';
import { categoryAssignmentExists, transactionAssignmentExists } from './categories';
import { hasSplitSql, resolveTransactionAccount } from './ledger';
import type { TransactionType } from './types';

// ---- Rules -------------------------------------------------------------
//
// User-defined source conditions and category/type assignments. Matching is
// exact-or-prefix for merchant text plus optional account/type/category scope.

export interface Rule {
  id: string;
  matchType: 'exact';
  matchValue: string;
  accountId?: string;
  sourceType?: TransactionType;
  sourceCategory?: string;
  sourceSubCategory?: string;
  category: string;
  subCategory?: string;
  categoryId?: string;
  subCategoryId?: string;
  type?: TransactionType;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

function rowToRule(r: typeof rules.$inferSelect): Rule {
  return {
    id: r.id,
    matchType: 'exact',
    matchValue: r.matchValue,
    accountId: r.accountId ?? undefined,
    sourceType: (r.sourceType as TransactionType | null) ?? undefined,
    sourceCategory: r.sourceCategory ?? undefined,
    sourceSubCategory: r.sourceSubCategory ?? undefined,
    category: r.category,
    subCategory: r.subCategory ?? undefined,
    categoryId: r.categoryId ?? undefined,
    subCategoryId: r.subCategoryId ?? undefined,
    type: (r.type as TransactionType | null) ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
  };
}

/** All rules for the user, ordered by match value. */
export async function listRules(userId: string): Promise<Rule[]> {
  const rows = await db.select().from(rules).where(eq(rules.userId, userId)).orderBy(asc(rules.matchValue));
  return rows.map(rowToRule);
}

/** Load every rule row for matching (import hot path). */
export async function listRulesForMatching(
  userId: string,
): Promise<Rule[]> {
  const rows = await db
    .select()
    .from(rules)
    .where(eq(rules.userId, userId));
  const assignments = await db
    .select({ categoryId: categories.id, subCategoryId: subCategories.id, category: categories.name, subCategory: subCategories.name, type: categories.type })
    .from(subCategories)
    .innerJoin(
      categories,
      and(eq(categories.userId, subCategories.userId), eq(categories.id, subCategories.mainCategoryId)),
    )
    .where(eq(categories.userId, userId));
  const valid = uniqueAssignmentsByName(assignments);
  return rows.flatMap((row) => {
    if (row.subCategory == null) return [];
    const assignment = valid.get(`${row.category}\0${row.subCategory}`);
    const validType = assignment
      && ((row.type != null && (row.type === assignment.type || row.category === 'Pay down goals'))
        || (row.type == null && row.category === 'Pay down goals'));
    if (!assignment || !validType) return [];
    return [{
      ...rowToRule(row),
      categoryId: assignment.categoryId,
      subCategoryId: assignment.subCategoryId,
    }];
  });
}

interface RuleWriteInput {
  matchType?: 'exact';
  matchValue: string;
  accountId?: string | null;
  sourceType?: TransactionType | null;
  sourceCategory?: string | null;
  sourceSubCategory?: string | null;
  category: string;
  subCategory?: string;
  type?: TransactionType | null;
}

interface RuleScope {
  matchValue: string;
  accountId?: string | null;
  sourceType?: TransactionType | null;
  sourceCategory?: string | null;
  sourceSubCategory?: string | null;
}

function sameRuleScope(row: typeof rules.$inferSelect, scope: RuleScope): boolean {
  return normalizeMerchant(row.matchValue) === normalizeMerchant(scope.matchValue)
    && (row.accountId ?? null) === (scope.accountId ?? null)
    && (row.sourceType ?? null) === (scope.sourceType ?? null)
    && (row.sourceCategory ?? null) === (scope.sourceCategory ?? null)
    && (row.sourceSubCategory ?? null) === (scope.sourceSubCategory ?? null);
}

function isBroadRule(row: typeof rules.$inferSelect): boolean {
  return row.accountId == null
    && row.sourceType == null
    && row.sourceCategory == null
    && row.sourceSubCategory == null;
}

async function findRuleByScope(userId: string, scope: RuleScope): Promise<typeof rules.$inferSelect | null> {
  const rows = await db.select().from(rules).where(eq(rules.userId, userId));
  return rows.find((row) => sameRuleScope(row, scope)) ?? null;
}

export async function createRule(
  userId: string,
  input: RuleWriteInput,
): Promise<Rule> {
  const id = `rule-${nanoid(10)}`;
  const matchType = input.matchType ?? 'exact';
  const trimmed = input.matchValue.trim();
  if (!trimmed) throw new Error('matchValue must not be empty');
  const assignment = input.subCategory ? await resolveCategoryAssignment(userId, input.category, input.subCategory) : null;
  if (!assignment || !input.type || (assignment.type !== input.type && input.category !== 'Pay down goals')) {
    throw Object.assign(new Error('Rule must set a valid category, subCategory, and matching type'), { status: 400 });
  }
  const inserted = await db
    .insert(rules)
    .values({
      id,
      userId,
      matchType,
      matchValue: trimmed,
      accountId: input.accountId ?? null,
      sourceType: input.sourceType ?? null,
      sourceCategory: input.sourceCategory ?? null,
      sourceSubCategory: input.sourceSubCategory ?? null,
      category: input.category,
      subCategory: input.subCategory ?? null,
      categoryId: assignment.categoryId,
      subCategoryId: assignment.subCategoryId,
      type: input.type ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    throw Object.assign(new Error('A rule with the same match conditions already exists'), { status: 409 });
  }
  return rowToRule(inserted[0]!);
}

export async function editRule(
  userId: string,
  id: string,
  patch: {
    matchValue?: string;
    accountId?: string | null;
    sourceType?: TransactionType | null;
    sourceCategory?: string | null;
    sourceSubCategory?: string | null;
    category?: string;
    subCategory?: string | null;
    type?: TransactionType | null;
  },
  expectedVersion?: number,
  ): Promise<Rule> {
  const [existing] = await db
    .select()
    .from(rules)
    .where(and(eq(rules.userId, userId), eq(rules.id, id)))
    .limit(1);
  if (!existing) throw Object.assign(new Error('Rule not found'), { status: 404 });
  const nextMatchValue = patch.matchValue?.trim() ?? existing.matchValue;
  if (!nextMatchValue) throw new Error('matchValue must not be empty');
  const nextSourceCategory = patch.sourceCategory === undefined ? existing.sourceCategory : patch.sourceCategory;
  const nextScope: RuleScope = {
    matchValue: nextMatchValue,
    accountId: patch.accountId === undefined ? existing.accountId : patch.accountId,
    sourceType: patch.sourceType === undefined ? existing.sourceType : patch.sourceType,
    sourceCategory: nextSourceCategory,
    sourceSubCategory: nextSourceCategory == null
      ? null
      : patch.sourceSubCategory === undefined ? existing.sourceSubCategory : patch.sourceSubCategory,
  };
  if ((nextScope.sourceCategory == null) !== (nextScope.sourceSubCategory == null)) {
    throw Object.assign(new Error('sourceCategory and sourceSubCategory must be set together'), { status: 400 });
  }
  const duplicate = await findRuleByScope(userId, nextScope);
  if (duplicate && duplicate.id !== id) {
    throw Object.assign(new Error('A rule with the same match conditions already exists'), { status: 409 });
  }
  const nextCategory = patch.category ?? existing.category;
  const nextSubCategory = patch.subCategory === undefined ? existing.subCategory : patch.subCategory;
  const nextType = patch.type === undefined ? existing.type : patch.type;
  const targetIsValid = nextSubCategory
    && (nextType
      ? await transactionAssignmentExists(userId, nextCategory, nextSubCategory, nextType)
      : nextCategory === 'Pay down goals'
        && await categoryAssignmentExists(userId, nextCategory, nextSubCategory));
  if (!targetIsValid) {
    throw Object.assign(new Error('Rule must set a valid category, subCategory, and matching type'), { status: 400 });
  }
  const assignment = await resolveCategoryAssignment(userId, nextCategory, nextSubCategory!);
  if (!assignment) throw Object.assign(new Error('Rule target is ambiguous or no longer exists'), { status: 400 });
  const updated = await db
    .update(rules)
    .set({
      matchValue: nextMatchValue,
      accountId: nextScope.accountId ?? null,
      sourceType: nextScope.sourceType ?? null,
      sourceCategory: nextScope.sourceCategory ?? null,
      sourceSubCategory: nextScope.sourceSubCategory ?? null,
      category: patch.category ?? existing.category,
      // `subCategory` / `type` use explicit `null` so the user can clear
      // them. `undefined` means "don't touch".
      subCategory:
        patch.subCategory === undefined ? existing.subCategory : patch.subCategory === null ? null : patch.subCategory,
      categoryId: assignment.categoryId,
      subCategoryId: assignment.subCategoryId,
      type: patch.type === undefined ? existing.type : patch.type === null ? null : patch.type,
      updatedAt: new Date(),
      version: sql`${rules.version} + 1`,
    })
    .where(and(
      eq(rules.userId, userId),
      eq(rules.id, id),
      expectedVersion !== undefined ? eq(rules.version, expectedVersion) : undefined,
    ))
    .returning();
  if (updated.length === 0) {
    throw Object.assign(new Error('The rule changed before confirmation; review it and try again'), { status: 409 });
  }
  return rowToRule(updated[0]!);
}

export async function deleteRule(userId: string, id: string): Promise<void> {
  await db.delete(rules).where(and(eq(rules.userId, userId), eq(rules.id, id)));
}

export type RuleFromTransactionResult =
  | { status: 'created' | 'narrowed' | 'updated' | 'unchanged'; rule: Rule }
  | { status: 'confirmation_required'; rule: Rule };

/** Build a fully-scoped rule from immutable source values and current assignment. */
export async function createRuleFromTransaction(
  userId: string,
  transactionId: string,
  replaceRuleId?: string,
  expectedVersion?: number,
): Promise<RuleFromTransactionResult> {
  const [transaction] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, transactionId)))
    .limit(1);
  if (!transaction) throw Object.assign(new Error('Transaction not found'), { status: 404 });
  if (
    !transaction.subCategory
    || !(await transactionAssignmentExists(userId, transaction.category, transaction.subCategory, transaction.type))
  ) {
    throw Object.assign(new Error('Transaction must have a valid category assignment'), { status: 400 });
  }
  const account = transaction.accountId
    ? { id: transaction.accountId }
    : await resolveTransactionAccount(userId, transaction.account);
  const input: RuleWriteInput = {
    matchValue: transaction.merchant,
    accountId: account.id,
    sourceType: transaction.sourceClassificationTrusted ? transaction.sourceType : null,
    sourceCategory: transaction.sourceClassificationTrusted && transaction.sourceSubCategory
      ? transaction.sourceCategory
      : null,
    sourceSubCategory: transaction.sourceClassificationTrusted ? transaction.sourceSubCategory : null,
    category: transaction.category,
    subCategory: transaction.subCategory,
    type: transaction.type,
  };
  const userRules = await db.select().from(rules).where(eq(rules.userId, userId));
  const scoped = userRules.find((row) => sameRuleScope(row, input));
  const broad = pickBestRuleMatch({
    merchant: transaction.merchant,
    accountId: account.id,
    sourceType: transaction.sourceType,
    sourceCategory: transaction.sourceCategory,
    sourceSubCategory: transaction.sourceSubCategory ?? undefined,
  }, userRules.filter(isBroadRule));
  const conflict = scoped ?? broad;
  if (conflict) {
    const narrowingBroad = broad?.id === conflict.id;
    const assignmentMatches = conflict.category === input.category
      && (conflict.subCategory ?? null) === (input.subCategory ?? null)
      && (conflict.type ?? null) === (input.type ?? null);
    if (scoped && assignmentMatches) return { status: 'unchanged', rule: rowToRule(conflict) };
    if (replaceRuleId !== conflict.id) {
      return { status: 'confirmation_required', rule: rowToRule(conflict) };
    }
    if (expectedVersion === undefined || conflict.version !== expectedVersion) {
      return { status: 'confirmation_required', rule: rowToRule(conflict) };
    }
    const updated = await editRule(userId, conflict.id, {
      matchValue: narrowingBroad ? conflict.matchValue : input.matchValue,
      accountId: input.accountId,
      sourceType: input.sourceType,
      sourceCategory: input.sourceCategory,
      sourceSubCategory: input.sourceSubCategory,
      category: input.category,
      subCategory: input.subCategory,
      type: input.type,
    }, conflict.version);
    return { status: narrowingBroad ? 'narrowed' : 'updated', rule: updated };
  }
  if (replaceRuleId) {
    throw Object.assign(new Error('The rule changed before confirmation; review it and try again'), { status: 409 });
  }
  try {
    return { status: 'created', rule: await createRule(userId, input) };
  } catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
    const raced = await findRuleByScope(userId, input);
    if (
      raced
      && raced.category === input.category
      && (raced.subCategory ?? null) === (input.subCategory ?? null)
      && (raced.type ?? null) === (input.type ?? null)
    ) {
      return { status: 'unchanged', rule: rowToRule(raced) };
    }
    throw error;
  }
}

/**
 * Re-apply a single rule to every matching transaction in the user's
 * ledger. The "Run" (▶) button on the Rules page. Returns the number
 * of rows whose category/subCategory/type was actually changed so the
 * route can show an accurate "Updated N transactions" toast.
 *
 * Matching uses the same exact-or-prefix rules as import. Type is
 * only written when the rule has a non-null type.
 */
export async function applyRuleToAllMatchingTransactions(userId: string, ruleId: string): Promise<{ updated: number }> {
  const [rule] = await db
    .select()
    .from(rules)
    .where(and(eq(rules.userId, userId), eq(rules.id, ruleId)))
    .limit(1);
  if (!rule) throw new Error('Rule not found');
  const allRules = await listRulesForMatching(userId);
  const resolvedRule = allRules.find((candidate) => candidate.id === rule.id);
  if (!resolvedRule) {
    throw new Error('Rule must assign a valid sub-category and matching type before it can run');
  }

  const candidates = await db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      accountId: transactions.accountId,
      sourceCategory: transactions.sourceCategory,
      sourceSubCategory: transactions.sourceSubCategory,
      sourceType: transactions.sourceType,
      sourceClassificationTrusted: transactions.sourceClassificationTrusted,
      category: transactions.category,
      subCategory: transactions.subCategory,
      type: transactions.type,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.categoryUserModified, false),
      sql`NOT (${hasSplitSql()})`,
    ));

  const idsToUpdate: string[] = [];
  for (const row of candidates) {
    const best = pickBestRuleMatch({
      merchant: row.merchant,
      accountId: row.accountId ?? undefined,
      sourceCategory: row.sourceCategory,
      sourceSubCategory: row.sourceSubCategory ?? undefined,
      sourceType: row.sourceType,
      sourceClassificationTrusted: row.sourceClassificationTrusted,
    }, allRules);
    if (best?.id !== rule.id) continue;
    const catDiff = row.category !== resolvedRule.category;
    const subDiff = (row.subCategory ?? null) !== (resolvedRule.subCategory ?? null);
    const typeDiff = resolvedRule.type != null && row.type !== resolvedRule.type;
    if (catDiff || subDiff || typeDiff || row.needsReview) idsToUpdate.push(row.id);
  }

  if (idsToUpdate.length === 0) return { updated: 0 };

  await db
    .update(transactions)
    .set({
      category: resolvedRule.category,
      subCategory: resolvedRule.subCategory,
      categoryId: resolvedRule.categoryId,
      subCategoryId: resolvedRule.subCategoryId,
      ...(resolvedRule.type != null ? { type: resolvedRule.type } : {}),
      needsReview: false,
    })
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.categoryUserModified, false),
      inArray(transactions.id, idsToUpdate),
    ));

  return { updated: idsToUpdate.length };
}

/**
 * Re-apply every rule to the user's ledger in one pass. For each
 * transaction, picks the best matching rule (longest matchValue, same
 * as import) and updates category/subCategory/type when they differ.
 * Grouped by rule so each category set is one bulk UPDATE.
 *
 * Used by the "Run all rules" button on the Rules page.
 */
export async function applyAllRulesToMatchingTransactions(userId: string): Promise<{ updated: number }> {
  const ruleRows = await listRulesForMatching(userId);
  if (ruleRows.length === 0) return { updated: 0 };

  const candidates = await db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      accountId: transactions.accountId,
      sourceCategory: transactions.sourceCategory,
      sourceSubCategory: transactions.sourceSubCategory,
      sourceType: transactions.sourceType,
      sourceClassificationTrusted: transactions.sourceClassificationTrusted,
      category: transactions.category,
      subCategory: transactions.subCategory,
      type: transactions.type,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.categoryUserModified, false),
      sql`NOT (${hasSplitSql()})`,
    ));

  // ruleId → transaction ids that need that rule's category applied
  const byRule = new Map<string, string[]>();
  for (const row of candidates) {
    const best = pickBestRuleMatch({
      merchant: row.merchant,
      accountId: row.accountId ?? undefined,
      sourceCategory: row.sourceCategory,
      sourceSubCategory: row.sourceSubCategory ?? undefined,
      sourceType: row.sourceType,
      sourceClassificationTrusted: row.sourceClassificationTrusted,
    }, ruleRows);
    if (!best) continue;
    const catDiff = row.category !== best.category;
    const subDiff = (row.subCategory ?? null) !== (best.subCategory ?? null);
    const typeDiff = best.type != null && row.type !== best.type;
    if (!catDiff && !subDiff && !typeDiff && !row.needsReview) continue;
    const list = byRule.get(best.id) ?? [];
    list.push(row.id);
    byRule.set(best.id, list);
  }

  let updated = 0;
  for (const rule of ruleRows) {
    const ids = byRule.get(rule.id);
    if (!ids?.length) continue;
    await db
      .update(transactions)
      .set({
        category: rule.category,
        subCategory: rule.subCategory,
        categoryId: rule.categoryId,
        subCategoryId: rule.subCategoryId,
        ...(rule.type != null ? { type: rule.type } : {}),
        needsReview: false,
      })
      .where(and(
        eq(transactions.userId, userId),
        eq(transactions.categoryUserModified, false),
        inArray(transactions.id, ids),
      ));
    updated += ids.length;
  }

  return { updated };
}

