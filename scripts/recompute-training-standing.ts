/**
 * Recompute training-day standing for every live or upcoming term's designated
 * training cycle.
 *
 * Dry-run by default, which writes nothing and prints who would move and why:
 *
 *   npm run training:standing:dry
 *   npm run training:standing:apply
 *
 * The reminders sweep does the same work daily, so this exists for the one time
 * it matters most -- right after deploy, when the mock clinic rule first
 * applies to a term whose training day has already happened -- so the change
 * can be read before it reaches anybody rather than discovered from a digest.
 *
 * NOTE: `npm run` passes --env-file=.env, and that file's DATABASE_URL points at
 * PRODUCTION. Check which database you are on before --apply.
 */
import { prisma } from "@/platform/db";
import {
  loadTrainingDayFacts,
  partsComplete,
  recomputeTrainingStanding,
  trainingDayParts,
} from "@/platform/training/standing";

const apply = process.argv.includes("--apply");

async function main() {
  const cycles = await prisma.recruitmentCycle.findMany({
    where: { isTermTraining: true, term: { status: { in: ["ACTIVE", "PLANNING"] } } },
    select: { id: true, title: true, termId: true, track: true, term: { select: { name: true } } },
  });
  if (cycles.length === 0) {
    console.log("No designated training cycle in a live or upcoming term. Nothing to do.");
    return;
  }

  for (const cycle of cycles) {
    console.log(`\n${cycle.term.name} ${cycle.track}: ${cycle.title}`);
    const [members, rows] = await Promise.all([
      prisma.termMembership.findMany({
        where: { termId: cycle.termId, kind: cycle.track, status: "ACTIVE" },
        select: { personId: true },
        distinct: ["personId"],
      }),
      prisma.training.findMany({ where: { termId: cycle.termId, track: cycle.track }, select: { personId: true } }),
    ]);
    const people = [...new Set([...members, ...rows].map((r) => r.personId))];

    let unchanged = 0;
    const moves: { name: string; from: string; to: string; detail: string }[] = [];
    for (const personId of people) {
      const loaded = await loadTrainingDayFacts(prisma, { personId, termId: cycle.termId, track: cycle.track });
      if (!loaded) continue;
      const parts = trainingDayParts(loaded.facts);
      const complete = partsComplete(parts);
      const existing = await prisma.training.findUnique({
        where: { personId_termId_track: { personId, termId: cycle.termId, track: cycle.track } },
        select: { status: true },
      });
      const was = existing?.status ?? "none";
      const now = complete ? "COMPLETE" : "PENDING";
      if (was === now) {
        unchanged += 1;
      } else {
        const person = await prisma.person.findUnique({ where: { id: personId }, select: { name: true } });
        moves.push({
          name: person?.name ?? personId,
          from: was,
          to: now,
          detail: `morning ${parts.morning}, mock clinic ${parts.mockClinic}`,
        });
      }
      if (apply) await recomputeTrainingStanding(prisma, { personId, termId: cycle.termId, track: cycle.track });
    }

    console.log(`  ${people.length} people, ${unchanged} unchanged, ${moves.length} moving`);
    for (const m of moves) console.log(`  ${m.from} -> ${m.to}  ${m.name}  (${m.detail})`);
  }

  console.log(apply ? "\nApplied." : "\nDry run. Nothing was written; pass --apply to write.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
