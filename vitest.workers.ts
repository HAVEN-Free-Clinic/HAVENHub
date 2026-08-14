import os from "node:os";

/**
 * The migrated database that every per-worker database is cloned from. Worktrees
 * override TEST_DATABASE_URL to get their own, so the clones follow whichever
 * database this checkout is pointed at.
 */
export const TEMPLATE_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://haven:haven_dev@localhost:5434/havenhub_test";

/**
 * How many vitest workers run, and therefore how many databases global setup
 * clones. Config, global setup, and per-worker setup all read this one function:
 * if they disagreed, a worker would connect to a database nobody created and
 * fail with an opaque connection error instead of an obvious one.
 *
 * Set VITEST_WORKERS to pin it (CI runners size this differently from a laptop).
 */
export function testWorkerCount(): number {
  const override = Number(process.env.VITEST_WORKERS);
  if (Number.isInteger(override) && override > 0) return override;
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  // Postgres is the bottleneck here, not CPU, and every worker holds its own
  // connection pool against the same server. Leave a core for the main process
  // and stop at eight, past which the workers contend more than they help.
  return Math.max(1, Math.min(cpus - 1, 8));
}

/**
 * Which of the cloned databases a worker should use.
 *
 * VITEST_POOL_ID is not bounded by maxForks: vitest recycles a fork after each
 * file (isolate defaults to true) and hands the replacement the next number, so
 * an eight-fork run readily reaches id 30. Folding it into range is safe because
 * ids are handed out in increasing order and at most `count` forks are alive at
 * once, so the live ids are always `count` consecutive integers, and any run of
 * `count` consecutive integers covers `count` distinct residues. Two live
 * workers therefore never land on the same database.
 */
export function workerSlot(poolId: number, count = testWorkerCount()): number {
  if (!Number.isInteger(poolId) || poolId < 1) return 1;
  return ((poolId - 1) % count) + 1;
}

/**
 * Connection URL for one worker's private clone. Slots are 1-based.
 *
 * connection_limit is pinned low on purpose. Prisma otherwise sizes the pool
 * from the CPU count (2n+1) per client, which across eight workers approaches
 * Postgres's default max_connections of 100 and starts failing runs with
 * connection errors rather than test failures. A worker runs one test at a time,
 * so a handful of connections covers the occasional Promise.all in a fixture.
 */
export function workerDatabaseUrl(slot: number): string {
  const url = new URL(TEMPLATE_DATABASE_URL);
  url.pathname = `${url.pathname}_w${slot}`;
  url.searchParams.set("connection_limit", "5");
  return url.toString();
}

/** Bare database name from a connection URL, for use in CREATE/DROP DATABASE. */
export function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}
