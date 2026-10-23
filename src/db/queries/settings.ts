import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { settings } from '../schema/settings';

// ---- Settings (key-value) -----------------------------------------------

export async function getSetting(userId: string, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, key)))
    .limit(1);
  return row?.value ?? null;
}

export async function setSetting(userId: string, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ userId, key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [settings.userId, settings.key],
      set: { value, updatedAt: new Date() },
    });
}

export async function deleteSetting(userId: string, key: string): Promise<void> {
  await db.delete(settings).where(and(eq(settings.userId, userId), eq(settings.key, key)));
}
