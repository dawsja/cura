/**
 * Report range resolution shared by the REST reports routes and MCP tools.
 *
 * Range tokens are resolved relative to "today" (UTC) so the chart
 * boundaries are stable across timezones. When retention is enabled, ranges
 * are clamped to the same centrally computed cutoff used by cleanup.
 */
import { z } from 'zod';
import { getEarliestReportDate } from '@/db/queries';
import { retentionPolicy } from '@/lib/retention';

export const ReportRange = z.enum(['1m', '3m', '6m', '1y', 'all']);
export type ReportRange = z.infer<typeof ReportRange>;

/**
 * Inclusive [fromDate, toDate] in 'YYYY-MM-DD' for the given range
 * token. `toDate` is end-of-today’s month for the reporting window so
 * that "1m" includes the full in-progress month. `all` starts at the user's
 * earliest accepted transaction. Every range is clamped when retention is on.
 */
export async function resolveReportRange(
  user: string,
  range: ReportRange,
  now: Date = new Date(),
): Promise<{ fromDate: string; toDate: string }> {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const retentionFloor = retentionPolicy(now).cutoffDate;

  // toDate = last day of the current month (inclusive).
  const endOfThisMonth = new Date(Date.UTC(y, m + 1, 0));
  const toDate = endOfThisMonth.toISOString().slice(0, 10);

  let startMonthOffset: number;
  switch (range) {
    case '1m':
      startMonthOffset = 0;
      break;
    case '3m':
      startMonthOffset = 2;
      break;
    case '6m':
      startMonthOffset = 5;
      break;
    case '1y':
      startMonthOffset = 11;
      break;
    case 'all':
      startMonthOffset = 0;
      break;
  }

  const start = new Date(Date.UTC(y, m - startMonthOffset, 1));
  let fromDate = range === 'all'
    ? (await getEarliestReportDate(user)) ?? start.toISOString().slice(0, 10)
    : start.toISOString().slice(0, 10);
  if (retentionFloor && fromDate < retentionFloor) fromDate = retentionFloor;
  return { fromDate, toDate };
}
