import { mkdirSync } from "node:fs";
import { workerDatabaseUrl, workerSlot, workerUploadDir } from "./vitest.workers";

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

// Upload directory: a temp path, so certificate service tests do not write into
// the project tree. Set BEFORE any config import. Per worker and per worktree,
// for the same reasons the database is; see workerUploadDir.
process.env.UPLOAD_DIR = workerUploadDir(workerSlot(Number(process.env.VITEST_POOL_ID)));
// Created up front: several suites readdir() it in beforeEach, which throws
// ENOENT on a directory no test has written to yet.
mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

// A test run must not reach a real external service, and must not behave
// differently on a developer's machine than it does in CI.
//
// .env holds live credentials for the dev server. Anything that loads .env
// before the tests import config leaves them in process.env, and constructing a
// PrismaClient does exactly that, which @/platform/db does at import. config.ts
// and the settings registry then read them as defaults, so a local run silently
// diverged from CI, which has none of them set. Two ways that already bit:
// storage/index.ts selects the R2 driver on Boolean(R2_BUCKET), so local runs
// wrote uploads into the production bucket and then failed their on-disk
// assertions; and the email.sender setting falls back to EMAIL_SENDER, so the
// transport tests asserting a refusal-with-no-sender could not fail locally.
//
// Claimed as empty rather than deleted: dotenv only fills in names that are
// absent, so occupying them now is what stops the later .env load from
// reinstating the real ones. Empty is how config.ts already spells "not
// configured" for every key here (each is optional, and the R2 all-or-nothing
// check tests truthiness), so validation still passes. Tests that need a
// configured integration pass it to loadConfig() or mock the config module.
for (const key of [
  // Object storage. Empty R2_BUCKET selects the local disk driver.
  "R2_BUCKET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  // Email. EMAIL_SENDER backs the email.sender setting's envDefault; the rest
  // are the credentials the two live transports validate against.
  "EMAIL_SENDER",
  "GRAPH_OAUTH_TENANT_ID",
  "GRAPH_OAUTH_CLIENT_ID",
  "GRAPH_OAUTH_CLIENT_SECRET",
  "GRAPH_OAUTH_REDIRECT_URI",
  "MAILEROO_API_KEY",
  // The verified-domain allowlist override. Claimed so the suite always exercises
  // the shipped default table, never whatever a developer has pointed their own
  // deploy at.
  "SENDING_DOMAINS",
  // The address-level Graph list, claimed for the same reason and with more at
  // stake: a developer whose .env names the clinic's shared mailboxes would
  // otherwise route those addresses to Graph in every routing test, and the
  // suite would pass locally on facts CI does not have.
  "GRAPH_SENDER_ADDRESSES",
  // Airtable import sources.
  "AIRTABLE_PAT",
  "AIRTABLE_MIRROR_ENABLED",
  "AIRTABLE_MIRROR_BASE_ID",
  "AIRTABLE_MIRROR_PEOPLE_TABLE_ID",
  "AIRTABLE_MIRROR_FIELD_MAP",
  "ALL_PEOPLE_TABLE_ID",
  "HAVEN_MGMT_BASE_ID",
  "SU26_ROSTER_TABLE_ID",
  // Yale SSO.
  "AZURE_AD_TENANT_ID",
  "AZURE_AD_CLIENT_ID",
  "AZURE_AD_CLIENT_SECRET",
]) {
  process.env[key] = "";
}

// Worktree: node_modules is symlinked to the main project whose .env has
// EMAIL_TRANSPORT=graph. Force log transport so config validation passes
// without requiring Graph credentials during tests.
//
// Assigned unconditionally, not with `??`. Anything that loads .env before the
// workers fork (constructing a PrismaClient does) leaves .env's transport in the
// inherited environment, and a `??` here would defer to it and point the suite
// at a real mailbox. "log" is the only one of the three that delivers nowhere,
// and a test run has no business selecting either live transport, so this is not
// negotiable by the surrounding environment. Tests that need to exercise the
// graph or maileroo config pass it to loadConfig() directly.
process.env.EMAIL_TRANSPORT = "log";
