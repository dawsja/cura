import { withAdvisoryLock } from '@/db/client';

export type JobName = 'simplefin-poll' | 'budget-rollforward' | 'retention' | 'demo-reset' | 'mcp-auth-cleanup';

export type JobRunResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'skipped'; reason: 'in_process' | 'advisory_lock' };

const runningNames = new Set<JobName>();
const activeJobs = new Set<Promise<unknown>>();

/** Prevent duplicate runs locally and across replicas while tracking shutdown work. */
export async function runExclusiveJob<T>(name: JobName, work: () => Promise<T>): Promise<JobRunResult<T>> {
  if (runningNames.has(name)) return { status: 'skipped', reason: 'in_process' };
  runningNames.add(name);

  const task = withAdvisoryLock(name, work);
  activeJobs.add(task);
  try {
    const result = await task;
    if (!result.acquired) return { status: 'skipped', reason: 'advisory_lock' };
    return { status: 'completed', value: result.value };
  } finally {
    activeJobs.delete(task);
    runningNames.delete(name);
  }
}

export async function waitForActiveJobs(): Promise<void> {
  const results = await Promise.allSettled([...activeJobs]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'active cron job failed during shutdown');
}
