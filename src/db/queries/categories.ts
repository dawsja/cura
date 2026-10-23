import { and, asc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../client';
import { categories } from '../schema/categories';
import { subCategories } from '../schema/sub_categories';
import { transactions } from '../schema/transactions';
import { transactionSplits } from '../schema/transaction_splits';
import { rules } from '../schema/rules';
import { seedInitialCategoriesIfEmpty } from './first-run';
import { resolveCategoryAssignment } from './category-assignments';
import type { MainCategory, SubCategory, TransactionType } from './types';

// ---- Categories + Sub-categories ----------------------------------------

export async function getAllCategories(userId: string): Promise<MainCategory[]> {
  await seedInitialCategoriesIfEmpty(userId);
  const [mainRows, subRows] = await Promise.all([
    // Stable order: user-defined `sortOrder` first (drag-to-reorder),
    // then `name` as a tiebreaker. Both Budget and the Categories page
    // render this list in the same order.
    db
      .select()
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
    // Sub-categories keep the order they were created in (the import from
    // Postgres inserted them in the order Postgres listed them).
    db.select().from(subCategories).where(eq(subCategories.userId, userId)).orderBy(sql`rowid`),
  ]);
  const subMap = new Map<string, SubCategory[]>();
  for (const s of subRows) {
    const list = subMap.get(s.mainCategoryId) ?? [];
    list.push({
      id: s.id,
      name: s.name,
      planned: s.planned,
      icon: s.icon ?? undefined,
    });
    subMap.set(s.mainCategoryId, list);
  }
  return mainRows.map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    icon: m.icon ?? undefined,
    sortOrder: m.sortOrder,
    subCategories: subMap.get(m.id) ?? [],
  }));
}

/** True when a leaf sub-category belongs to the named main category. */
export async function categoryAssignmentExists(
  userId: string,
  category: string,
  subCategory: string,
): Promise<boolean> {
  return await resolveCategoryAssignment(userId, category, subCategory) !== null;
}

/** Validate a leaf plus transaction type, with Pay down goals intentionally type-agnostic. */
export async function transactionAssignmentExists(
  userId: string,
  category: string,
  subCategory: string,
  type: TransactionType,
): Promise<boolean> {
  const assignment = await resolveCategoryAssignment(userId, category, subCategory);
  return assignment !== null && (assignment.type === type || category === 'Pay down goals');
}

export async function mainCategoryExists(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .limit(1);
  return rows.length === 1;
}

export async function subCategoryExists(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: subCategories.id })
    .from(subCategories)
    .where(and(eq(subCategories.userId, userId), eq(subCategories.id, id)))
    .limit(1);
  return rows.length === 1;
}

/**
 * Case-insensitive name match for duplicate checks. Done in JS because
 * SQLite's lower() only folds ASCII letters.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function addMainCategory(
  userId: string,
  name: string,
  type: TransactionType,
  icon = 'Folder',
): Promise<MainCategory> {
  if (name.trim().toLowerCase() === 'pay down goals') {
    throw Object.assign(new Error('Pay down goals is managed from the Pay down page'), { status: 400 });
  }
  return db.transaction(async (tx) => {
    const siblings = await tx.select({ name: categories.name }).from(categories).where(eq(categories.userId, userId));
    if (siblings.some((sibling) => sameName(sibling.name, name))) throw Object.assign(new Error('A category with this name already exists'), { status: 409 });
    const id = `cat-${nanoid(10)}`;
    const [top] = await tx
      .select({ sortOrder: categories.sortOrder })
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(sql`${categories.sortOrder} DESC`)
      .limit(1);
    const nextOrder = (top?.sortOrder ?? -1) + 1;
    await tx.insert(categories).values({ id, userId, name, type, icon, sortOrder: nextOrder });
    return { id, name, type, icon, sortOrder: nextOrder, subCategories: [] };
  });
}

export async function editMainCategory(userId: string, id: string, name: string): Promise<void> {
  if (name.trim().toLowerCase() === 'pay down goals') {
    throw Object.assign(new Error('Pay down goals is managed from the Pay down page'), { status: 400 });
  }
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ name: categories.name })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id)))
      .limit(1);
    if (!existing || existing.name === name) return;
    if (existing.name === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goals is managed from the Pay down page'), { status: 400 });
    }
    const siblings = await tx.select({ name: categories.name }).from(categories).where(and(
      eq(categories.userId, userId),
      sql`${categories.id} <> ${id}`,
    ));
    if (siblings.some((sibling) => sameName(sibling.name, name))) throw Object.assign(new Error('A category with this name already exists'), { status: 409 });

    await tx
      .update(categories)
      .set({ name })
      .where(and(eq(categories.userId, userId), eq(categories.id, id)));
    await tx
      .update(transactions)
      .set({ category: name })
      .where(and(eq(transactions.userId, userId), eq(transactions.categoryId, id)));
    await tx
      .update(transactionSplits)
      .set({ category: name })
      .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.categoryId, id)));
    await tx
      .update(rules)
      .set({ category: name, updatedAt: new Date(), version: sql`${rules.version} + 1` })
      .where(and(eq(rules.userId, userId), eq(rules.categoryId, id)));
  });
}

export async function deleteMainCategory(userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [category] = await tx
      .select({ name: categories.name })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id)))
      .limit(1);
    if (!category) return;
    if (category.name === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goals is managed from the Pay down page'), { status: 400 });
    }
    await tx.update(transactions).set({ categoryId: null, subCategoryId: null }).where(and(eq(transactions.userId, userId), eq(transactions.categoryId, id)));
    await tx.update(transactionSplits).set({ categoryId: null, subCategoryId: null }).where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.categoryId, id)));
    await tx
      .delete(rules)
      .where(
        and(
          eq(rules.userId, userId),
          eq(rules.categoryId, id),
        ),
      );
    await tx.delete(categories).where(and(eq(categories.userId, userId), eq(categories.id, id)));
  });
}

/**
 * Persist a new user-defined ordering for the user's main categories.
 * `orderedIds[0]` becomes sortOrder 0, `orderedIds[1]` becomes 1, etc.
 * Categories not in the list keep their existing order (we only touch
 * the ones the user moved, so a partial reorder is safe).
 *
 * We use one UPDATE per id rather than a CASE expression to keep the
 * SQL portable and the per-row order obvious in pg logs.
 */
export async function reorderMainCategories(userId: string, orderedIds: string[]): Promise<void> {
  // De-dupe + drop ids that don't belong to this user. The route layer
  // is the source of truth for membership; this is defense in depth.
  const unique = Array.from(new Set(orderedIds));
  for (let i = 0; i < unique.length; i++) {
    await db
      .update(categories)
      .set({ sortOrder: i })
      .where(and(eq(categories.userId, userId), eq(categories.id, unique[i]!)));
  }
}

export async function addSubCategory(
  userId: string,
  mainCategoryId: string,
  name: string,
  planned: number,
): Promise<SubCategory> {
  return db.transaction(async (tx) => {
    const parent = await tx.select({ id: categories.id, name: categories.name }).from(categories).where(and(
      eq(categories.userId, userId),
      eq(categories.id, mainCategoryId),
    )).limit(1);
    if (parent.length !== 1) throw new Error('Main category not found');
    if (parent[0]!.name === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goal categories follow their account names'), { status: 400 });
    }
    const siblings = await tx.select({ name: subCategories.name }).from(subCategories).where(and(
      eq(subCategories.userId, userId),
      eq(subCategories.mainCategoryId, mainCategoryId),
    ));
    if (siblings.some((sibling) => sameName(sibling.name, name))) throw Object.assign(new Error('A sub-category with this name already exists'), { status: 409 });
    const id = `sub-${nanoid(10)}`;
    await tx.insert(subCategories).values({ id, userId, mainCategoryId, name, planned });
    return { id, name, planned };
  });
}

export async function editSubCategory(
  userId: string,
  mainCategoryId: string,
  subCategoryId: string,
  name: string,
  planned?: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ name: subCategories.name, mainName: categories.name })
      .from(subCategories)
      .innerJoin(
        categories,
        and(eq(categories.id, subCategories.mainCategoryId), eq(categories.userId, subCategories.userId)),
      )
      .where(
        and(
          eq(subCategories.userId, userId),
          eq(subCategories.id, subCategoryId),
          eq(subCategories.mainCategoryId, mainCategoryId),
        ),
      )
      .limit(1);
    if (!existing) return;
    if (existing.mainName === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goal categories follow their account names'), { status: 400 });
    }
    const siblings = await tx.select({ name: subCategories.name }).from(subCategories).where(and(
      eq(subCategories.userId, userId),
      eq(subCategories.mainCategoryId, mainCategoryId),
      sql`${subCategories.id} <> ${subCategoryId}`,
    ));
    if (siblings.some((sibling) => sameName(sibling.name, name))) throw Object.assign(new Error('A sub-category with this name already exists'), { status: 409 });

    await tx
      .update(subCategories)
      .set(planned === undefined ? { name } : { name, planned })
      .where(
        and(
          eq(subCategories.userId, userId),
          eq(subCategories.id, subCategoryId),
          eq(subCategories.mainCategoryId, mainCategoryId),
        ),
      );
    if (existing.name === name) return;

    const oldAssignment = and(
      eq(transactions.userId, userId),
      eq(transactions.subCategoryId, subCategoryId),
    );
    await tx.update(transactions).set({ subCategory: name }).where(oldAssignment);
    await tx
      .update(transactionSplits)
      .set({ subCategory: name })
      .where(
        and(
          eq(transactionSplits.userId, userId),
          eq(transactionSplits.subCategoryId, subCategoryId),
        ),
      );
    await tx
      .update(rules)
      .set({ subCategory: name, updatedAt: new Date(), version: sql`${rules.version} + 1` })
      .where(
        and(eq(rules.userId, userId), eq(rules.subCategoryId, subCategoryId)),
      );
  });
}

export async function deleteSubCategory(userId: string, mainCategoryId: string, subCategoryId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [assignment] = await tx
      .select({ category: categories.name, subCategory: subCategories.name })
      .from(subCategories)
      .innerJoin(
        categories,
        and(eq(categories.userId, subCategories.userId), eq(categories.id, subCategories.mainCategoryId)),
      )
      .where(
        and(
          eq(subCategories.userId, userId),
          eq(subCategories.mainCategoryId, mainCategoryId),
          eq(subCategories.id, subCategoryId),
        ),
      )
      .limit(1);
    if (!assignment) return;
    if (assignment.category === 'Pay down goals') {
      throw Object.assign(new Error('Pay down goal categories are removed with their accounts'), { status: 400 });
    }
    await tx.update(transactions).set({ subCategoryId: null }).where(and(eq(transactions.userId, userId), eq(transactions.subCategoryId, subCategoryId)));
    await tx.update(transactionSplits).set({ subCategoryId: null }).where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.subCategoryId, subCategoryId)));
    await tx
      .delete(rules)
      .where(
        and(
          eq(rules.userId, userId),
          eq(rules.subCategoryId, subCategoryId),
        ),
      );
    await tx
      .delete(subCategories)
      .where(
        and(
          eq(subCategories.userId, userId),
          eq(subCategories.mainCategoryId, mainCategoryId),
          eq(subCategories.id, subCategoryId),
        ),
      );
  });
}

