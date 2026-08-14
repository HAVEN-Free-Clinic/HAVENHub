import { PrismaClient } from "@prisma/client";
import {
  TEMPLATE_DATABASE_URL,
  databaseName,
  testWorkerCount,
  workerDatabaseUrl,
} from "./vitest.workers";

/**
 * Give every vitest worker its own database, cloned from the migrated template.
 *
 * The suite is dominated by integration tests that call resetDb() before each
 * case, and resetDb TRUNCATEs every table. With one shared database that forces
 * fileParallelism: false, because a truncate in one file would delete rows a
 * concurrently running file was still using. Cloning per worker removes the
 * shared state, so the files can actually run in parallel.
 *
 * CREATE DATABASE ... TEMPLATE is a file copy, not a migration replay, so this
 * costs a fraction of a second per worker even though the schema has 129
 * migrations. Clones are recreated on every run, which also means a worker
 * database can never drift from the schema the way a long-lived one does.
 */
export default async function setup(): Promise<void> {
  const template = databaseName(TEMPLATE_DATABASE_URL);
  const adminUrl = new URL(TEMPLATE_DATABASE_URL);
  adminUrl.pathname = "/postgres";

  // Constructing a PrismaClient loads .env into process.env, and this runs in the
  // parent process that every worker is forked from, so anything it adds is
  // inherited by all of them. .env holds the production values (EMAIL_TRANSPORT
  // =graph among them), and vitest.setup.ts defaults several variables with `??`,
  // which silently defers to whatever is already set. Leaving the pollution in
  // place would point tests at the live email transport. Snapshot the names that
  // existed beforehand and drop anything new once the clones are made.
  const preexistingKeys = new Set(Object.keys(process.env));

  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    // CREATE DATABASE ... TEMPLATE refuses to run while any other session is
    // connected to the template, and an interrupted run can leave one behind.
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      template
    );

    for (let workerId = 1; workerId <= testWorkerCount(); workerId++) {
      const name = databaseName(workerDatabaseUrl(workerId));
      // Serial on purpose: concurrent CREATE ... TEMPLATE from the same template
      // serializes on a lock anyway, and doing it by hand keeps the error
      // attributable to one worker.
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not prepare the per-worker test databases from template "${template}".\n` +
        `Start the local Postgres with \`npm run db:up\` and migrate the template with ` +
        `\`npm run test:prepare\`, then re-run.\n\n${message}`
    );
  } finally {
    await admin.$disconnect();
    for (const key of Object.keys(process.env)) {
      if (!preexistingKeys.has(key)) delete process.env[key];
    }
  }
}
