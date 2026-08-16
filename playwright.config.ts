import { defineConfig } from "@playwright/test";

// The e2e suite drives a real dev server against a real database, seeding and
// deleting rows as it goes. `npm run dev` makes Next.js load `.env`, whose
// DATABASE_URL points at the production Neon database, so without an explicit
// override a local `npx playwright test` runs the whole suite against live
// clinic data. That has happened, and it left test rows in production.
//
// Resolve the database here instead and hand it to the dev server explicitly.
// Variables already present in the environment win (CI sets them per-job);
// everything else falls back to the local throwaway Postgres. `.env` never gets
// a say, because Next.js does not override variables that are already set in the
// process environment, and this config file is loaded without dotenv.
const DEFAULT_E2E_DATABASE_URL = "postgresql://haven:haven_dev@localhost:5434/havenhub_test";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_E2E_DATABASE_URL;
const databaseUrlUnpooled = process.env.DATABASE_URL_UNPOOLED ?? databaseUrl;

/**
 * Fail the run rather than warn: the suite mutates and deletes rows, so a hosted
 * database is never the intended target. Escape hatch is deliberate and explicit.
 */
function assertLocalDatabase(label: string, url: string): void {
  if (process.env.E2E_ALLOW_REMOTE_DB === "1") return;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // An unparseable URL is not provably local, so treat it as unsafe.
    throw new Error(`Refusing to run e2e: ${label} is not a parseable connection URL.`);
  }

  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      `Refusing to run e2e against a non-local database.\n` +
        `  ${label} resolves to host "${hostname}".\n` +
        `The suite creates, mutates, and deletes rows, so it must target a throwaway database.\n` +
        `Start one with \`npm run db:up\`, or set E2E_ALLOW_REMOTE_DB=1 to override deliberately.`
    );
  }
}

assertLocalDatabase("DATABASE_URL", databaseUrl);
assertLocalDatabase("DATABASE_URL_UNPOOLED", databaseUrlUnpooled);

// Publish the resolved URLs into THIS process, not just the dev server's.
//
// e2e/fixtures.ts builds its own PrismaClient and, finding no DATABASE_URL,
// used to fall back to reading `.env` -- the production Neon URL. So the run
// the block above exists to prevent was still half-happening: the dev server
// was pointed at a throwaway database while the fixtures seeded, mutated, and
// deleted rows in production. CI never saw it because CI sets DATABASE_URL.
//
// Setting it here closes that, and it also makes the two halves agree by
// construction: the app under test and the fixtures now read the same resolved,
// asserted-local URL.
process.env.DATABASE_URL = databaseUrl;
process.env.DATABASE_URL_UNPOOLED = databaseUrlUnpooled;

export default defineConfig({
  testDir: "e2e",
  // Run serially. The Next.js dev server compiles routes on demand in a single
  // process; running specs concurrently makes the heavy recruitment specs (build a
  // form, publish, apply) contend for it and time out. Serial is slower but reliable.
  workers: 1,
  // Safety net for any residual cold-compile slowness on the first hit of a route.
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://localhost:3100/api/health",
    // Merged over process.env for the spawned dev server, and Next.js leaves
    // already-set variables alone, so these beat whatever `.env` contains.
    //
    // DEV_DATABASE_URL is the one that actually lands. The command is `npm run
    // dev`, whose script begins `DATABASE_URL=${DEV_DATABASE_URL:-...havenhub}`,
    // and that inline assignment overrides anything passed in here -- so the
    // DATABASE_URL below was silently discarded and the app ran against the
    // developer's own `havenhub` database no matter what this config resolved.
    // The script honours DEV_DATABASE_URL, so setting it is what makes the
    // resolved URL reach the server. DATABASE_URL stays for `next dev` itself
    // and for anything that reads it before the script's assignment.
    env: {
      DEV_DATABASE_URL: databaseUrl,
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrlUnpooled,
      // Keeps the content blocker gate out of the suite. It mounts only when
      // this is set, and a modal that cannot be dismissed would fail every spec
      // behind it. Cleared explicitly rather than left to chance: the env below
      // is merged OVER process.env, so a value in the developer's own shell (set
      // to verify the gate by hand) would otherwise reach the dev server.
      NEXT_PUBLIC_INTERCOM_APP_ID: "",
    },
    // Caveat: when a server is already listening on 3100 this reuses it as-is,
    // and the guard above cannot vouch for a database it did not configure. Port
    // 3100 is e2e-only by convention, so in practice the reused server is one a
    // previous run started. Set to false if you want the check to be absolute.
    reuseExistingServer: true,
    // CI cold-starts the dev server and compiles on first request, so allow headroom.
    timeout: 120_000,
  },
});
