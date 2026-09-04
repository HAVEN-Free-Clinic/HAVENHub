/**
 * Refuses to let a destructive test helper run against anything but a local
 * test database.
 *
 * WHY THIS EXISTS (incident, 2026-09-04): the production Neon database was
 * truncated by a local vitest run. The chain was:
 *
 *   1. Docker was down, so `vitest.globalsetup.ts` (which clones the local test
 *      database) could not run, and someone worked around it with a hand-written
 *      config that skipped BOTH `globalSetup` and `setupFiles`.
 *   2. `vitest.setup.ts` is what pins the suite to a database: it assigns
 *      `process.env.DATABASE_URL = workerDatabaseUrl(...)` unconditionally.
 *      Skipping it left that assignment undone.
 *   3. `@/platform/db` then constructs `new PrismaClient()` with no explicit
 *      URL. Prisma loads `.env`, and `.env` on a developer machine holds the
 *      PRODUCTION `DATABASE_URL`.
 *   4. `resetDb()` ran `TRUNCATE ... CASCADE` against it. The tests passed,
 *      because from the suite's point of view the truncate succeeded.
 *
 * Every layer there was working as designed except the last one: nothing
 * between "a Prisma client exists" and "truncate 70 tables" ever asked *which
 * database*. This module is that question, asked before the damage.
 *
 * The check deliberately reads `process.env.DATABASE_URL` at call time rather
 * than trusting the caller, because that env var is exactly what Prisma
 * resolved the connection from, and it is what the missing setup file would
 * have overwritten.
 *
 * There is intentionally NO environment-variable escape hatch. An override is
 * how a guard like this quietly dies: the next person hitting a red test at
 * 3pm sets the variable and moves on. Loosening this should require editing
 * this file and its test, so it shows up in a diff and a review.
 */

/** Hosts that cannot be a managed/remote database. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Marker every test database name must carry. Worker clones are `<template>_w<N>`. */
const TEST_NAME_MARKER = "test";

export class UnsafeDatabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDatabaseTargetError";
  }
}

/**
 * Throw unless `rawUrl` points at a local test database.
 *
 * Two independent conditions, both required, so that neither a remote host with
 * a test-looking name nor a local copy of production satisfies it alone:
 *
 * - the host is loopback, and
 * - the database name contains "test".
 */
export function assertLocalTestDatabase(rawUrl = process.env.DATABASE_URL): void {
  if (!rawUrl) {
    throw new UnsafeDatabaseTargetError(
      "Refusing to run a destructive test helper: DATABASE_URL is not set, so the target database cannot be verified. " +
        "Tests are meant to run through vitest.setup.ts, which pins DATABASE_URL to a per-worker local clone.",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeDatabaseTargetError(
      "Refusing to run a destructive test helper: DATABASE_URL is not a parseable URL, so the target database cannot be verified.",
    );
  }

  const host = url.hostname;
  const name = url.pathname.replace(/^\//, "");

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new UnsafeDatabaseTargetError(
      `Refusing to TRUNCATE a database on a non-local host: ${host}. ` +
        "A destructive test helper may only run against a loopback database. " +
        "This almost always means the suite was started without vitest.setup.ts (which pins DATABASE_URL to a local " +
        "per-worker clone), so Prisma fell back to the DATABASE_URL in .env, which points at production. " +
        "Run the suite through the project's vitest config, and start the local database with `npm run db:up`.",
    );
  }

  if (!name.toLowerCase().includes(TEST_NAME_MARKER)) {
    throw new UnsafeDatabaseTargetError(
      `Refusing to TRUNCATE a database whose name does not mark it as a test database: "${name}". ` +
        `The host is local, but a destructive helper still requires "${TEST_NAME_MARKER}" in the database name, ` +
        "so that a local copy of real data cannot be wiped by a stray test run. " +
        "The suite's own databases are named havenhub_test and havenhub_test_w<N>.",
    );
  }
}
