import { and, asc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../client';
import { accounts } from '../schema/accounts';
import { goals } from '../schema/goals';
import { getAccount } from './accounts';

// ---- Goals -------------------------------------------------------------

export interface Goal {
  id: string;
  name: string;
  target: number;
  startingValue: number;
  accountId: string | null;
  // The live balance of the watched account, looked up at read time so
  // the progress bar always reflects the freshest figure. Null when
  // the account was deleted/hidden — the UI renders a notice instead
  // of a progress bar in that case.
  accountBalance: number | null;
  accountName: string | null;
}

/**
 * Fetch every goal for the user, with the watched account's current
 * balance joined in. We do the join in code rather than SQL because:
 *   1. The account might be hidden — we still want to return the goal
 *      (with a NULL balance) so the user can re-attach via edit.
 *   2. The account might be deleted — same story.
 *   3. The set is small (goals are personal; ~5-20 rows typical).
 */
export async function getAllGoals(userId: string): Promise<Goal[]> {
  const [goalRows, accountRows] = await Promise.all([
    // rowid breaks createdAt ties in creation order.
    db.select().from(goals).where(eq(goals.userId, userId)).orderBy(asc(goals.createdAt), sql`rowid`),
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        balance: accounts.balance,
      })
      .from(accounts)
      .where(eq(accounts.userId, userId)),
  ]);
  const byId = new Map<string, { name: string; balance: number }>();
  for (const a of accountRows) byId.set(a.id, { name: a.name, balance: a.balance });
  return goalRows.map((g) => {
    const acc = g.accountId ? byId.get(g.accountId) : undefined;
    return {
      id: g.id,
      name: g.name,
      target: g.target,
      startingValue: g.startingValue,
      accountId: g.accountId,
      accountBalance: acc ? acc.balance : null,
      accountName: acc ? acc.name : null,
    };
  });
}

export async function addGoal(
  userId: string,
  input: {
    name: string;
    target: number;
    startingValue: number;
    accountId: string | null;
  },
): Promise<Goal> {
  if (input.accountId && !(await getAccount(userId, input.accountId))) throw new Error('Account not found');
  const id = `goal-${nanoid(10)}`;
  await db.insert(goals).values({
    id,
    userId,
    name: input.name,
    target: input.target,
    startingValue: input.startingValue,
    accountId: input.accountId,
  });
  return {
    id,
    name: input.name,
    target: input.target,
    startingValue: input.startingValue,
    accountId: input.accountId,
    // New goal — balance comes from the joined read, not the add.
    accountBalance: null,
    accountName: null,
  };
}

export async function editGoal(
  userId: string,
  id: string,
  patch: {
    name?: string;
    target?: number;
    startingValue?: number;
    accountId?: string | null;
  },
): Promise<void> {
  if (patch.accountId && !(await getAccount(userId, patch.accountId))) throw new Error('Account not found');
  const [existing] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.id, id)))
    .limit(1);
  if (!existing) return;
  await db
    .update(goals)
    .set({
      name: patch.name ?? existing.name,
      target: patch.target ?? existing.target,
      startingValue: patch.startingValue ?? existing.startingValue,
      // `accountId` uses the explicit `null` check so the user can
      // detach the goal from its watched account. `undefined` means
      // "don't touch"; `null` means "clear".
      accountId: patch.accountId === undefined ? existing.accountId : patch.accountId === null ? null : patch.accountId,
    })
    .where(and(eq(goals.userId, userId), eq(goals.id, id)));
}

export async function deleteGoal(userId: string, id: string): Promise<void> {
  await db.delete(goals).where(and(eq(goals.userId, userId), eq(goals.id, id)));
}

