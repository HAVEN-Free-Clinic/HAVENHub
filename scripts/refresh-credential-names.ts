/**
 * Re-issue service credentials whose frozen name is no longer the person's name.
 *
 * Dry-run by default; pass --apply to write changes.
 *
 *   npm run credentials:names:dry
 *   npm run credentials:names:apply
 *
 * A ServiceCredential freezes the whole ServiceRecord at issue and never
 * recomputes it on read. That is right for the SERVICE facts -- the document
 * attests to terms already served, and those must not drift. It is wrong for the
 * name, which is not a fact about the service but the identity of the person the
 * document is about. A credential issued before the name split carries whatever
 * free-text `Person.name` held at the time, parenthetical nickname and all, and
 * that string is what the public credential page and the wallet badge show.
 *
 * This re-issues through issueServiceCredential, the same path the app uses, so
 * the record is recomputed properly and the audit trail records it. publicToken
 * is preserved by that function, so a link the member has already shared keeps
 * working.
 *
 * Safe to re-run: a credential whose name already matches is skipped.
 */
import { prisma } from "@/platform/db";
import { issueServiceCredential } from "@/modules/passport/services/credential";

type Frozen = { name?: string } | null;

async function main() {
  const dryRun = !process.argv.includes("--apply");

  console.log(
    dryRun ? "DRY RUN -- no changes will be written." : "APPLY MODE -- writing to database.",
  );
  console.log();

  const rows = await prisma.serviceCredential.findMany({
    select: {
      personId: true,
      record: true,
      issuedAt: true,
      publicToken: true,
      revokedAt: true,
      person: { select: { name: true } },
    },
    orderBy: { issuedAt: "asc" },
  });

  const stale = rows.filter((r) => ((r.record as Frozen)?.name ?? null) !== r.person.name);

  console.log(`${rows.length} issued credential(s); ${stale.length} carry a stale name.`);
  console.log();

  if (stale.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  for (const row of stale) {
    const frozen = (row.record as Frozen)?.name ?? "(no name in record)";
    console.log(`  ${row.personId}`);
    console.log(`    was : ${JSON.stringify(frozen)}`);
    console.log(`    now : ${JSON.stringify(row.person.name)}`);
    console.log(
      `    published=${row.publicToken !== null}  revoked=${row.revokedAt !== null}  issued=${row.issuedAt.toISOString().slice(0, 10)}`,
    );

    if (!dryRun) {
      const issued = await issueServiceCredential(row.personId);
      console.log(`    re-issued as: ${JSON.stringify(issued.record.name)}`);
    }
    console.log();
  }

  if (dryRun) {
    console.log("Re-run with --apply to re-issue these.");
  } else {
    console.log(`Re-issued ${stale.length} credential(s).`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
