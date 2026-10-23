import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { categories } from '../schema/categories';
import { subCategories } from '../schema/sub_categories';
import type { TransactionType } from './types';

export interface ResolvedCategoryAssignment {
  categoryId: string;
  subCategoryId: string;
  category: string;
  subCategory: string;
  type: TransactionType;
}

export function uniqueAssignmentsByName<T extends { category: string; subCategory: string }>(rows: T[]): Map<string, T> {
  const unique = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = `${row.category}\0${row.subCategory}`;
    if (duplicates.has(key)) continue;
    if (unique.has(key)) {
      unique.delete(key);
      duplicates.add(key);
    } else {
      unique.set(key, row);
    }
  }
  return unique;
}

export async function resolveCategoryAssignment(
  userId: string,
  category: string,
  subCategory: string,
): Promise<ResolvedCategoryAssignment | null> {
  const rows = await db
    .select({
      categoryId: categories.id,
      subCategoryId: subCategories.id,
      category: categories.name,
      subCategory: subCategories.name,
      type: categories.type,
    })
    .from(subCategories)
    .innerJoin(categories, and(eq(categories.id, subCategories.mainCategoryId), eq(categories.userId, subCategories.userId)))
    .where(and(
      eq(categories.userId, userId),
      eq(categories.name, category),
      eq(subCategories.userId, userId),
      eq(subCategories.name, subCategory),
    ))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}
