/**
 * In-process cron scheduler. Started by src/index.ts on app boot (gated by
 * the `RUN_CRON` env var, default true).
 *
 * Schedules are HARDCODED — operators cannot tune them. Rationale:
 *   - SIMPLEFIN_POLL_CRON respects SimpleFIN's documented <=24 requests/day
 *     quota. 12/day leaves headroom for the 4-call first-sync backfill
 *     and ad-hoc manual syncs.
 *   - BUDGET_ROLLFORWARD_CRON runs on the 1st of the month to roll
 *     budget carry-forwards forward before the user opens the app.
 *   - RETENTION_CRON runs daily at 04:00 UTC (after roll-forward). It is a
 *     no-op unless the operator opts in with RETENTION_DAYS > 0.
 *   - MCP_AUTH_CLEANUP_CRON runs daily at 04:30 UTC and deletes MCP access
 *     tokens that expired more than 30 days ago.
 *
 * Every run uses local exclusion plus a session-level PostgreSQL advisory
 * lock, so replicas can safely leave cron enabled. The lock session is
 * separate from the pool connections used by the job itself.
 */
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { logger } from '@/lib/logger';
import { runSimpleFinPollForAllUsers } from './simplefin-poll';
import { runBudgetRollforward } from './budget-rollforward';
import { runRetention } from './retention';
import { cleanupMcpAuth } from '@/db/mcp-access';
import { resetDemoDatabase } from '@/db/demo-reset';
import { env } from '@/lib/env';
import { runExclusiveJob, waitForActiveJobs, type JobName } from './lifecycle';

// Hardcoded cron expressions — see file header for rationale.
const SIMPLEFIN_POLL_CRON = '17 */2 * * *'; // every 2 hours = 12 requests/day; avoid top-of-hour load
const BUDGET_ROLLFORWARD_CRON = '0 0 1 * *'; // 1st of month, 00:00 UTC
const RETENTION_CRON = '0 4 * * *'; // daily, 04:00 UTC
const MCP_AUTH_CLEANUP_CRON = '30 4 * * *'; // daily, 04:30 UTC
const DEMO_RESET_CRON = '*/15 * * * *'; // UTC quarter-hours

export interface CronHandle {
  stop(): Promise<void>;
  waitForIdle(): Promise<void>;
}

async function runCronJob<T>(name: JobName, work: () => Promise<T>): Promise<void> {
  logger.info({ job: name }, 'cron: tick');
  try {
    const result = await runExclusiveJob(name, work);
    if (result.status === 'skipped') {
      logger.info({ job: name, reason: result.reason }, 'cron: skipped overlapping run');
      return;
    }
    logger.info({ job: name, result: result.value }, 'cron: done');
  } catch (err) {
    logger.error({ err, job: name }, 'cron: failed');
  }
}

export function startCron(): CronHandle {
  if (env.DEMO_MODE) {
    if (!cron.validate(DEMO_RESET_CRON)) {
      throw new Error(`invalid DEMO_RESET_CRON: ${DEMO_RESET_CRON}`);
    }
    logger.warn({ reset: DEMO_RESET_CRON }, 'cron: demo mode enabled; database resets are scheduled');
    const task = cron.schedule(
      DEMO_RESET_CRON,
      () => void runCronJob('demo-reset', resetDemoDatabase),
      { timezone: 'UTC' },
    );
    return {
      async stop() {
        await task.stop();
        logger.info('cron: stopped');
      },
      waitForIdle: waitForActiveJobs,
    };
  }

  logger.info(
    {
      simplefin: SIMPLEFIN_POLL_CRON,
      rollforward: BUDGET_ROLLFORWARD_CRON,
      retention: RETENTION_CRON,
      mcpAuthCleanup: MCP_AUTH_CLEANUP_CRON,
    },
    'cron: starting',
  );

  if (!cron.validate(SIMPLEFIN_POLL_CRON)) {
    throw new Error(`invalid SIMPLEFIN_POLL_CRON: ${SIMPLEFIN_POLL_CRON}`);
  }
  if (!cron.validate(BUDGET_ROLLFORWARD_CRON)) {
    throw new Error(`invalid BUDGET_ROLLFORWARD_CRON: ${BUDGET_ROLLFORWARD_CRON}`);
  }
  if (!cron.validate(RETENTION_CRON)) {
    throw new Error(`invalid RETENTION_CRON: ${RETENTION_CRON}`);
  }
  if (!cron.validate(MCP_AUTH_CLEANUP_CRON)) {
    throw new Error(`invalid MCP_AUTH_CLEANUP_CRON: ${MCP_AUTH_CLEANUP_CRON}`);
  }

  const options = { timezone: 'UTC' };
  const tasks: ScheduledTask[] = [
    cron.schedule(SIMPLEFIN_POLL_CRON, () => void runCronJob('simplefin-poll', runSimpleFinPollForAllUsers), options),
    cron.schedule(BUDGET_ROLLFORWARD_CRON, () => void runCronJob('budget-rollforward', runBudgetRollforward), options),
    cron.schedule(RETENTION_CRON, () => void runCronJob('retention', runRetention), options),
    cron.schedule(MCP_AUTH_CLEANUP_CRON, () => void runCronJob('mcp-auth-cleanup', () => cleanupMcpAuth()), options),
  ];

  logger.info('cron: scheduled');
  return {
    async stop() {
      await Promise.all(tasks.map((task) => task.stop()));
      logger.info('cron: stopped');
    },
    waitForIdle: waitForActiveJobs,
  };
}

// Allow running just the cron entrypoint for ad-hoc local use
// (`bun run src/jobs/cron.ts`). Not used in the default compose.
if (import.meta.main) {
  startCron();
}
