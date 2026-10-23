/**
 * Returns 'YYYY-MM-DD' for the last day of `yearMonth`. Uses date math
 * (day 0 of next month) so it handles month-length correctly without a
 * lookup table — leap-year-safe.
 */
export function endOfMonth(yearMonth: string): string {
  const [yStr, mStr] = yearMonth.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this month
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
