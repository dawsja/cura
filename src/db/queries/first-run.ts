import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { categories } from '../schema/categories';
import { subCategories } from '../schema/sub_categories';
import { settings } from '../schema/settings';
import { INITIAL_CATEGORIES } from '../seed';

// ---- First-time user seeding ---------------------------------------------

export async function seedInitialCategoriesIfEmpty(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Defaults are a one-time onboarding action. The marker preserves user
    // deletions; missing default IDs must never be interpreted as corruption.
    const [seeded] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.userId, userId), eq(settings.key, 'initial_categories_seeded')))
      .limit(1);
    const existing = await tx
      .select({
        id: categories.id,
        name: categories.name,
        type: categories.type,
        icon: categories.icon,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .where(eq(categories.userId, userId));

    // The startup transfer backfill used to run before a new user's first
    // category read. That left exactly one canonical Transfer row, which the
    // old seeder mistook for a customized tree and marked complete. Repair only
    // that narrow signature; all other seeded/customized trees stay untouched.
    const [onlyCategory] = existing;
    const transferOnlyBootstrap = existing.length === 1
      && onlyCategory?.id === `${userId}__cat-transfer`
      && onlyCategory.name === 'Transfer'
      && onlyCategory.type === 'transfer'
      && onlyCategory.icon === 'ArrowLeftRight'
      && onlyCategory.sortOrder === 9999;
    if (seeded && !transferOnlyBootstrap) return;

    // Existing users predate the marker. Preserve their current tree exactly,
    // including categories they intentionally removed, and mark it complete.
    if (existing.length > 0 && !transferOnlyBootstrap) {
      await tx
        .insert(settings)
        .values({ userId, key: 'initial_categories_seeded', value: 'v2', updatedAt: new Date() })
        .onConflictDoNothing();
      return;
    }

    for (const cat of INITIAL_CATEGORIES) {
      // The seed-time IDs in `INITIAL_CATEGORIES` (e.g. "cat-income") are
      // stable for documentation but not unique across users — they collide on
      // the global primary key. Prefix with a per-user token so each user gets
      // a private copy of the default tree.
      const mainId = `${userId}__${cat.id}`;
      await tx
        .insert(categories)
        .values({
          id: mainId,
          userId,
          name: cat.name,
          type: cat.type,
        })
        .onConflictDoNothing();
      if (cat.subCategories.length > 0) {
        await tx
          .insert(subCategories)
          .values(
            cat.subCategories.map((sub) => ({
              id: `${userId}__${sub.id}`,
              userId,
              mainCategoryId: mainId,
              name: sub.name,
              planned: sub.planned,
            })),
          )
          .onConflictDoNothing();
      }
    }
    await tx
      .insert(settings)
      .values({ userId, key: 'initial_categories_seeded', value: 'v2', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [settings.userId, settings.key],
        set: { value: 'v2', updatedAt: new Date() },
      });
  });
}
