import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getNextTerm } from "./next-term";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

function term(
  code: string,
  startDate: string,
  endDate: string,
  status: "ACTIVE" | "PLANNING" | "ARCHIVED"
) {
  return prisma.term.create({
    data: { code, name: code, startDate: new Date(startDate), endDate: new Date(endDate), status },
  });
}

it("returns null when there is no PLANNING term", async () => {
  await term("SU26", "2026-05-30", "2026-09-26", "ACTIVE");
  expect(await getNextTerm()).toBeNull();
});

it("returns the single PLANNING term that starts after the live one", async () => {
  await term("SU26", "2026-05-30", "2026-09-26", "ACTIVE");
  const fa = await term("FA26", "2026-09-01", "2027-01-01", "PLANNING");
  expect((await getNextTerm())?.id).toBe(fa.id);
});

// audit 14. activateTerm demotes a displaced future-dated term to PLANNING so an
// early flip stays recoverable, which used to leave the term that JUST ENDED as
// the only PLANNING row -- and therefore as "next". /volunteers/offboarding
// defaults to its Transition tab whenever a next term exists, and that tab
// pre-checks everyone not in "next" for bulk offboarding, so an inverted answer
// pre-selects the entire incoming class.
it("never returns a PLANNING term that starts before the live term", async () => {
  const su = await term("SU26", "2026-05-30", "2026-09-26", "PLANNING"); // demoted by an early flip
  await term("FA26", "2026-09-01", "2027-01-01", "ACTIVE");

  expect(await getNextTerm()).toBeNull();
  // Sanity: the demoted term really is PLANNING, so the null is the date rule
  // talking and not an empty table.
  expect((await prisma.term.findUniqueOrThrow({ where: { id: su.id } })).status).toBe("PLANNING");
});

// audit 14 (SCHED-5). `orderBy: startDate desc` returned the furthest-out term,
// so a term being prepared for next year hid the imminent one everywhere --
// including /schedule/requests, which would show none of the shift requests
// actually waiting on a decision.
it("returns the SOONEST upcoming PLANNING term, not the furthest out", async () => {
  await term("SU26", "2026-05-30", "2026-09-26", "ACTIVE");
  const fa = await term("FA26", "2026-09-01", "2027-01-01", "PLANNING");
  await term("SP27", "2027-01-12", "2027-05-29", "PLANNING");

  expect((await getNextTerm())?.id).toBe(fa.id);
});

it("falls back to the soonest PLANNING term when no term is ACTIVE", async () => {
  const fa = await term("FA26", "2026-09-01", "2027-01-01", "PLANNING");
  await term("SP27", "2027-01-12", "2027-05-29", "PLANNING");

  expect((await getNextTerm())?.id).toBe(fa.id);
});
