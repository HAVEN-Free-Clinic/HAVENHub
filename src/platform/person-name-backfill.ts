/**
 * The one-time split of the free-text `Person.name` column into real parts.
 *
 * The migration that added the columns left every existing row carrying a crude
 * SQL placeholder and `nameNeedsReview = true`. This is the pass that replaces
 * the placeholder with the guarded split in person-name.ts, and clears the flag
 * on the rows it can read with confidence.
 *
 * Dry-run by default; pass --apply to write. Safe to re-run: a row whose flag
 * has been cleared is a row a human has confirmed, and is never re-guessed. That
 * makes the script resumable, so a crash leaves a clean prefix written and the
 * next run picks up the rest.
 *
 * Writes go through `prisma.person.update` rather than raw SQL on purpose: the
 * client extension recomputes `name` from the parts, so this module never has to
 * remember to keep the derived column in step.
 */
import { prisma } from "./db";
import { splitPersonName } from "./person-name";

export type BackfillRow = {
  id: string;
  before: string;
  after: string;
  legalFirstName: string;
  lastName: string;
  preferredFirstName: string | null;
  outcome: "split" | "flagged" | "skipped";
};

export type BackfillReport = {
  rows: BackfillRow[];
  counts: { split: number; flagged: number; skipped: number };
};

export async function backfillPersonNames(
  { dryRun }: { dryRun: boolean } = { dryRun: true },
): Promise<BackfillReport> {
  const people = await prisma.person.findMany({
    select: { id: true, name: true, nameNeedsReview: true },
    orderBy: { id: "asc" },
  });

  const rows: BackfillRow[] = [];
  const counts = { split: 0, flagged: 0, skipped: 0 };

  for (const person of people) {
    // A cleared flag means a human has confirmed these parts. Re-splitting would
    // overwrite their correction with the guess they corrected.
    if (!person.nameNeedsReview) {
      counts.skipped += 1;
      rows.push({
        id: person.id,
        before: person.name,
        after: person.name,
        legalFirstName: "",
        lastName: "",
        preferredFirstName: null,
        outcome: "skipped",
      });
      continue;
    }

    const parts = splitPersonName(person.name);
    const outcome = parts.needsReview ? "flagged" : "split";
    counts[outcome] += 1;

    if (!dryRun) {
      await prisma.person.update({
        where: { id: person.id },
        data: {
          legalFirstName: parts.legalFirstName,
          legalMiddleName: parts.legalMiddleName,
          lastName: parts.lastName,
          preferredFirstName: parts.preferredFirstName,
          nameNeedsReview: parts.needsReview,
        },
      });
    }

    rows.push({
      id: person.id,
      before: person.name,
      after: [parts.preferredFirstName ?? parts.legalFirstName, parts.lastName]
        .filter(Boolean)
        .join(" "),
      legalFirstName: parts.legalFirstName,
      lastName: parts.lastName,
      preferredFirstName: parts.preferredFirstName,
      outcome,
    });
  }

  return { rows, counts };
}
