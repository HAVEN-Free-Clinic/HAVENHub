// One-off: rename the attendings that predate the Faculty Relations roster
// import so the import UPDATES them instead of creating a second row each.
//
// The old Airtable reproductive-health import named attendings by surname
// ("Finch", "Rivera"). The contact sheet produces full names ("Danielle Finch",
// "Nina Rivera"). The roster import matches on schedule name, so without this
// step eight physicians would end up on the roster twice -- the old rows holding
// the existing clinic assignments, the new ones holding whatever the schedule
// import wrote. Renaming first collapses that to one row per person, and because
// assignments key on id rather than name, every existing assignment survives.
//
// Attendings NOT listed here are left alone, including any who predate the sheet
// and are absent from it: an omission from a hand-kept spreadsheet is not
// evidence that someone has left.
//
// Dry-run by default.
//
//   npx tsx scripts/reconcile-attending-names.ts
//   npx tsx scripts/reconcile-attending-names.ts --apply
import { prisma } from "@/platform/db";

/**
 * Current schedule name -> the name the contact sheet produces.
 *
 * Confirmed against the live roster rather than derived: each left-hand value is
 * a real row in production today, and each right-hand value is exactly what
 * parseAttendingRoster yields for that person's contact-sheet entry.
 */
const RENAMES: Array<{ from: string; to: string }> = [
  { from: "Achong", to: "Natalie Marie Achong" },
  { from: "Ami", to: "Ami Marshall" },
  { from: "Ana", to: "Ana Rodriguez-Musterer" },
  { from: "Finch", to: "Danielle Finch" },
  { from: "Markowitz", to: "Melissa Markowitz" },
  { from: "Pringle", to: "Rebecca Pringle" },
  { from: "Rath", to: "Kristina Rath" },
  { from: "Rivera", to: "Nina Rivera" },
];

function describeDatabase(): string {
  const url = process.env.DATABASE_URL ?? "";
  const match = url.match(/@([^/]+)\/([^?]+)/);
  return match ? `${match[2]} at ${match[1]}` : "(DATABASE_URL not set)";
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Database: ${describeDatabase()}\n`);

  let renamed = 0;
  let missing = 0;
  let blocked = 0;

  for (const { from, to } of RENAMES) {
    const current = await prisma.attending.findUnique({
      where: { scheduleName: from },
      select: { id: true, fullName: true, _count: { select: { clinicDays: true } } },
    });
    if (!current) {
      console.log(`skip     "${from}" -> "${to}"  (no attending by that name)`);
      missing++;
      continue;
    }

    // The target may already exist if this ran before, or if the roster import
    // ran first and created the duplicate this script exists to prevent.
    // Renaming into it would violate the unique index, so stop and say so.
    const clash = await prisma.attending.findUnique({
      where: { scheduleName: to },
      select: { id: true },
    });
    if (clash && clash.id !== current.id) {
      console.log(
        `BLOCKED  "${from}" -> "${to}"  (a different attending already uses that name; ` +
          `merge them by hand)`,
      );
      blocked++;
      continue;
    }

    console.log(
      `rename   "${from}" -> "${to}"  (${current.fullName}, ${current._count.clinicDays} assignment(s) preserved)`,
    );
    renamed++;
    if (apply && !clash) {
      await prisma.attending.update({ where: { id: current.id }, data: { scheduleName: to } });
    }
  }

  console.log(`\nrenamed: ${renamed}   not found: ${missing}   blocked: ${blocked}`);
  if (blocked > 0) {
    console.log(
      "\nResolve the blocked names before importing, or the roster will hold two rows for those people.",
    );
  }
  console.log(apply ? "Reconcile complete." : "Dry run complete. Re-run with --apply to write.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
