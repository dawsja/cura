/**
 * Opt-in retention cleanup. RETENTION_DAYS=0 (the default) preserves all
 * history. Positive values delete transactions and budget overrides older
 * than the computed rolling cutoff.
 *
 * `monthly_budgets` is purged by yearMonth string comparison. Both deletes
 * commit atomically.
 */
import { sql } from 'drizzle-orm';
import { db, sqlRun } from '@/db/client';
import { logger } from '@/lib/logger';
import { retentionPolicy } from '@/lib/retention';

export interface RetentionReport {
  enabled: boolean;
  days: number;
  cutoffDate: string | null;
  cutoffYearMonth: string | null;
  transactionsDeleted: number;
  budgetsDeleted: number;
}

/**
 * Purge all matching rows in one transaction. Direct date predicates include
 * rows whose user has already been removed and avoid loading every deleted row
 * or doing separate pre-count scans.
 */
export async function runRetention(now: Date = new Date()): Promise<RetentionReport> {
  const policy = retentionPolicy(now);

  const report: RetentionReport = {
    ...policy,
    transactionsDeleted: 0,
    budgetsDeleted: 0,
  };
  if (!policy.enabled || !policy.cutoffDate || !policy.cutoffYearMonth) {
    logger.info({ report }, 'retention: disabled');
    return report;
  }

  const { cutoffDate, cutoffYearMonth } = policy;
  await db.transaction(async () => {
    // Carry each sub-category's latest pre-cutoff budget forward to the
    // cutoff month first, so purging history does not change what later
    // months inherit.
    await sqlRun(sql`
      INSERT INTO monthly_budgets (user_id, sub_category_id, year_month, planned, updated_at)
      SELECT user_id, sub_category_id, ${cutoffYearMonth}, planned, ${now.getTime()}
      FROM (
        SELECT user_id, sub_category_id, planned,
          row_number() OVER (PARTITION BY user_id, sub_category_id ORDER BY year_month DESC) AS latest
        FROM monthly_budgets
        WHERE year_month < ${cutoffYearMonth}
      )
      WHERE latest = 1
      ON CONFLICT (user_id, sub_category_id, year_month) DO NOTHING
    `);
    report.transactionsDeleted = (await sqlRun(sql`DELETE FROM transactions WHERE date < ${cutoffDate}`)).changes;
    report.budgetsDeleted = (await sqlRun(sql`DELETE FROM monthly_budgets WHERE year_month < ${cutoffYearMonth}`)).changes;
  });

  logger.info({ report }, 'retention: purged');
  return report;
}

if (import.meta.main) {
  runRetention()
    .then((r) => {
      logger.info({ r }, 'retention: result');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'retention: failed');
      process.exit(1);
    });
}
