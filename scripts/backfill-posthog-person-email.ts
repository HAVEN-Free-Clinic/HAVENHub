/**
 * Give every email-keyed PostHog person an `email` person property.
 *
 * Dry-run by default; pass --apply to send.
 *
 *   npm run backfill:posthog-email:dry
 *   npm run backfill:posthog-email:apply
 *   npm run backfill:posthog-email:apply -- --names   (also set `name`)
 *
 * WHY: server-side applicant events (drafts, submissions, magic links,
 * onboarding contracts) used the applicant's email as the distinct id and set no
 * person properties. The PostHog persons list reads only display-name
 * PROPERTIES (name, email), never the distinct id, so ~1,500 applicants showed
 * as bare UUIDs. captureEvent now stamps `email` on every email-keyed event
 * (src/platform/posthog/capture.ts); this script fixes the persons created
 * before that.
 *
 * Targets come from the PostHog Query API: every distinct id containing "@"
 * whose person has no `email` property. Each one gets an identify() with
 * `email` set to the distinct id VERBATIM. Never trim or lowercase it: the
 * identify must land on the person that already owns that id.
 *
 * --names also looks each email up in the Hub database (most recent Applicant
 * row for that address) and sets `name` when one is found. Read-only against
 * the database, but it reads whatever DATABASE_URL points at, which for this
 * script should be production.
 *
 * Safe to re-run: a person that already has an email drops out of the target
 * query, and identify() with the same properties is idempotent.
 *
 * Env:
 *   POSTHOG_PERSONAL_API_KEY           personal API key with query:read (targets)
 *   NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN  project token (sends the identifies)
 *   NEXT_PUBLIC_POSTHOG_HOST           ingest host, e.g. https://us.i.posthog.com
 *   POSTHOG_PROJECT_ID                 optional, defaults to 514029 (HAVEN Hub)
 *   POSTHOG_APP_HOST                   optional, defaults to https://us.posthog.com
 *   DATABASE_URL                       only with --names
 */
import { PostHog } from "posthog-node";
import { displayNameOf } from "@/platform/person-name";

const PROJECT_ID = process.env.POSTHOG_PROJECT_ID ?? "514029";
const APP_HOST = (process.env.POSTHOG_APP_HOST ?? "https://us.posthog.com").replace(/\/$/, "");
const PAGE_SIZE = 1000;
const BATCH_SIZE = 100;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/** Every email-shaped distinct id whose person has no email property. */
async function fetchTargets(apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await fetch(`${APP_HOST}/api/projects/${PROJECT_ID}/query/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: {
          kind: "HogQLQuery",
          query: `
            SELECT distinct_id
            FROM person_distinct_ids
            WHERE distinct_id LIKE '%@%'
              AND (person.properties.email IS NULL OR person.properties.email = '')
            ORDER BY distinct_id
            LIMIT ${PAGE_SIZE} OFFSET ${offset}
          `,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`PostHog query failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { results: [string][] };
    ids.push(...body.results.map(([id]) => id));
    if (body.results.length < PAGE_SIZE) return ids;
  }
}

/** email (lowercased) -> display name, from each address's most recent Applicant row. */
async function lookupNames(emails: string[]): Promise<Map<string, string>> {
  const { prisma } = await import("@/platform/db");
  const rows = await prisma.applicant.findMany({
    where: { emailLower: { in: emails.map((e) => e.toLowerCase()) } },
    select: { emailLower: true, firstName: true, lastName: true, preferredFirstName: true },
    orderBy: { createdAt: "asc" },
  });
  const names = new Map<string, string>();
  // Ascending order, so a later application overwrites an earlier one.
  for (const row of rows) {
    const name = displayNameOf({
      legalFirstName: row.firstName,
      lastName: row.lastName,
      preferredFirstName: row.preferredFirstName,
    });
    if (name) names.set(row.emailLower, name);
  }
  await prisma.$disconnect();
  return names;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const withNames = process.argv.includes("--names");

  console.log(dryRun ? "DRY RUN -- nothing will be sent to PostHog." : "APPLY MODE -- sending identifies.");
  console.log();

  const targets = await fetchTargets(requireEnv("POSTHOG_PERSONAL_API_KEY"));
  const names = withNames && targets.length > 0 ? await lookupNames(targets) : new Map<string, string>();

  console.log(`Targets (email distinct ids with no person email): ${targets.length}`);
  if (withNames) console.log(`  with a name found in the Hub database: ${names.size}`);
  console.log("First 5:");
  for (const id of targets.slice(0, 5)) {
    const name = names.get(id.toLowerCase());
    console.log(`  ${id}${name ? `  (${name})` : ""}`);
  }
  console.log();

  if (dryRun || targets.length === 0) {
    console.log(dryRun ? "Dry run complete. Re-run with --apply to send." : "Nothing to do.");
    return;
  }

  const client = new PostHog(requireEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN"), {
    host: requireEnv("NEXT_PUBLIC_POSTHOG_HOST"),
    flushAt: BATCH_SIZE,
    flushInterval: 0,
  });

  let sent = 0;
  for (const distinctId of targets) {
    const name = names.get(distinctId.toLowerCase());
    client.identify({
      distinctId,
      properties: { email: distinctId, ...(name ? { name } : {}) },
    });
    sent++;
    if (sent % BATCH_SIZE === 0) {
      await client.flush();
      console.log(`  sent ${sent}/${targets.length}`);
    }
  }
  await client.shutdown();

  console.log(`  sent ${sent}/${targets.length}`);
  console.log();
  console.log("Backfill sent. Person properties can take a few minutes to show in PostHog.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
