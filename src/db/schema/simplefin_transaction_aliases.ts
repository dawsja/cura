import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, primaryKey, foreignKey } from 'drizzle-orm/sqlite-core';
import { transactions } from './transactions';

/** Provider identities retained when a pending transaction becomes posted under a new ID. */
export const simpleFinTransactionAliases = sqliteTable(
  'simplefin_transaction_aliases',
  {
    userId: text('user_id').notNull(),
    externalId: text('external_id').notNull(),
    transactionId: text('transaction_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`),
  },
  (t) => ({
    primaryKey: primaryKey({ columns: [t.userId, t.externalId] }),
    transactionIdx: index('idx_simplefin_transaction_aliases_transaction').on(t.userId, t.transactionId),
    tenantTransactionFk: foreignKey({
      columns: [t.userId, t.transactionId],
      foreignColumns: [transactions.userId, transactions.id],
      name: 'simplefin_transaction_aliases_user_transaction_fk',
    }).onDelete('cascade'),
  }),
);
