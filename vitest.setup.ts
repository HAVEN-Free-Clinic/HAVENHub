import { mkdirSync } from "node:fs";
import { workerDatabaseUrl, workerSlot } from "./vitest.workers";

// Tests run against a dedicated test database, never the dev one. Each worker
// gets its own clone (created by vitest.globalsetup.ts) so that resetDb() in one
// worker cannot truncate rows another worker is still using, which is what lets
// the files run in parallel.
const databaseUrl = workerDatabaseUrl(workerSlot(Number(process.env.VITEST_POOL_ID)));
process.env.DATABASE_URL = databaseUrl;
// Prisma resolves the schema's directUrl from this even for non-migration work.
process.env.DATABASE_URL_UNPOOLED = databaseUrl;
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret";
// NODE_ENV intentionally omitted — vitest sets NODE_ENV=test automatically.

// Upload directory: use a stable temp path so certificate service tests do not
// write into the project tree. Set BEFORE any config import.
//
// Per worker, for the same reason the database is. Several suites claim the
// whole directory: my-info and the certificates importer readdir(UPLOAD_DIR) and
// delete every entry, and the importer's dry-run test asserts the directory is
// empty. Those are reasonable assertions about a directory the file owns, and
// they stay true only while no other worker is writing to the same path.
process.env.UPLOAD_DIR = `/tmp/havenhub-test-uploads/w${workerSlot(Number(process.env.VITEST_POOL_ID))}`;
// Created up front: the suites above readdir() it in beforeEach, which throws
// ENOENT on a directory no test has written to yet.
mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

// Storage must be the local disk driver, never a remote bucket. .env carries R2
// credentials for the dev server, and anything that loads .env before the tests
// import config leaves them in process.env; constructing a PrismaClient does it,
// and @/platform/db does that at import. src/platform/storage then sees
// R2_BUCKET, flips to the remote driver, and the upload suites both write into
// the real production bucket and fail their on-disk assertions with ENOENT.
// CI has no R2 variables, which is why this only ever bit local runs.
// Tests that need to exercise the R2 paths mock the config module instead.
//
// Claimed as empty rather than deleted: dotenv only fills in names that are
// absent, so occupying them now is what stops the later .env load from
// reinstating the real ones. Empty is also how config.ts already spells "not
// configured" (the all-or-nothing R2 check tests truthiness, and
// storage/index.ts keys the driver off Boolean(config.R2_BUCKET)), so
// validation still passes and the disk driver is selected.
process.env.R2_BUCKET = "";
process.env.R2_ACCOUNT_ID = "";
process.env.R2_ACCESS_KEY_ID = "";
process.env.R2_SECRET_ACCESS_KEY = "";

// Worktree: node_modules is symlinked to the main project whose .env has
// EMAIL_TRANSPORT=graph. Force log transport so config validation passes
// without requiring Graph credentials during tests.
//
// Assigned unconditionally, not with `??`. Anything that loads .env before the
// workers fork (constructing a PrismaClient does) leaves EMAIL_TRANSPORT=graph
// in the inherited environment, and a `??` here would defer to it and point the
// suite at the real mailbox. A test run has no business selecting a live
// transport, so this is not negotiable by the surrounding environment. Tests
// that need to exercise graph config pass it to loadConfig() directly.
process.env.EMAIL_TRANSPORT = "log";
