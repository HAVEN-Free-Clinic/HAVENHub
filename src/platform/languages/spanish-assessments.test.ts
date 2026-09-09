/**
 * The Spanish assessment history service.
 *
 * Every test here pins a defect the first cut of this feature shipped with, all
 * of which were unreachable from a test because the logic lived inline in a page
 * component's server actions.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { recordLanguageAssessment, verifyHistoricalAssessment } from "./index";
import {
  addPersonToSpanishHistory,
  latestSpanishAssessment,
  linkSpanishAssessmentToPerson,
  listAssessmentTerms,
  listSpanishAssessmentHistory,
  listSpanishFlagMismatches,
  normalizeModifier,
  normalizeScore,
  normalizeScoreAndModifier,
  updateSpanishAssessment,
  upsertSpanishAssessmentForTerm,
} from "./spanish-assessments";
import { CLINIC_WIDE_INTERPRETER_MIN_SCORE, LanguageValidationError } from "./catalog";
import { termRankOf } from "./assessment-terms";

const ACTOR = "assess-actor";

beforeEach(resetDb);

async function actor() {
  return prisma.person.create({ data: { id: ACTOR, name: "Interpreter Lead" } });
}

async function person(name: string, extra: { netId?: string; contactEmail?: string } = {}) {
  return prisma.person.create({ data: { name, ...extra } });
}

async function record(input: {
  personId?: string | null;
  term: string;
  score?: number | null;
  name?: string | null;
  email?: string;
  modifier?: string | null;
}) {
  return prisma.spanishAssessmentRecord.create({
    data: {
      email: input.email ?? "",
      name: input.name ?? null,
      personId: input.personId ?? null,
      term: input.term,
      termRank: termRankOf(input.term),
      score: input.score ?? null,
      modifier: input.modifier ?? null,
    },
  });
}

describe("normalizeScore", () => {
  it("accepts 1 through 5", () => {
    for (const n of [1, 2, 3, 4, 5]) expect(normalizeScore(String(n))).toBe(n);
  });

  // The half steps reached the select before any validator understood them.
  // parseInt("3.5") is 3, and 3 is an integer, so the old guard passed a
  // silently downgraded score straight through to both stores with a success
  // toast on top. Nothing in the suite fed it a half, so CI stayed green.
  it("accepts the half steps the scale offers", () => {
    for (const n of [1.5, 2.5, 3.5, 4.5]) expect(normalizeScore(String(n))).toBe(n);
  });

  it("rejects a fraction that is not a point on the scale", () => {
    expect(normalizeScore("3.25")).toBeNull();
    expect(normalizeScore("0.5")).toBeNull();
    expect(normalizeScore("5.5")).toBeNull();
  });

  it("rejects a number with trailing garbage rather than parsing a prefix", () => {
    expect(normalizeScore("3.5abc")).toBeNull();
    expect(normalizeScore("4 or 5")).toBeNull();
  });

  it("accepts a number as readily as its string", () => {
    expect(normalizeScore(3.5)).toBe(3.5);
    expect(normalizeScore(4)).toBe(4);
    expect(normalizeScore(3.25)).toBeNull();
  });

  it("treats an empty selection as no score, not as zero", () => {
    expect(normalizeScore("")).toBeNull();
    expect(normalizeScore(null)).toBeNull();
    expect(normalizeScore(undefined)).toBeNull();
  });

  it("rejects out-of-scale numbers rather than clamping them into the scale", () => {
    expect(normalizeScore("0")).toBeNull();
    expect(normalizeScore("6")).toBeNull();
    expect(normalizeScore("-1")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(normalizeScore("fluent")).toBeNull();
  });
});

describe("normalizeModifier", () => {
  it("accepts the two it knows and rejects anything else", () => {
    expect(normalizeModifier("plus")).toBe("plus");
    expect(normalizeModifier("minus")).toBe("minus");
    expect(normalizeModifier("")).toBeNull();
    expect(normalizeModifier("sideways")).toBeNull();
  });
});

describe("normalizeScoreAndModifier", () => {
  // "3.5+" is not a point on the scale. The history row inherits a modifier from
  // the import and the score select now offers halves, so both arrive on the
  // same form with nothing to stop the combination.
  it("drops an inherited modifier when the score is a half step", () => {
    expect(normalizeScoreAndModifier("3.5", "plus")).toEqual({ score: 3.5, modifier: null });
    expect(normalizeScoreAndModifier("4.5", "minus")).toEqual({ score: 4.5, modifier: null });
  });

  it("keeps the modifier on a whole score, so editing a legacy row leaves 4- alone", () => {
    expect(normalizeScoreAndModifier("4", "minus")).toEqual({ score: 4, modifier: "minus" });
    expect(normalizeScoreAndModifier("3", "plus")).toEqual({ score: 3, modifier: "plus" });
  });

  it("keeps a modifier with no score, which is how an unscored legacy row reads", () => {
    expect(normalizeScoreAndModifier("", "plus")).toEqual({ score: null, modifier: "plus" });
  });
});

describe("latestSpanishAssessment", () => {
  // The headline bug. Ordering on the term LABEL put "Summer 2012" ahead of
  // "Fall 2026", so the profile badge showed a fourteen-year-old score.
  it("returns the chronologically newest record, not the alphabetically last term", async () => {
    const p = await person("Sam Rivera");
    await record({ personId: p.id, term: "Summer 2012", score: 2 });
    await record({ personId: p.id, term: "Fall 2026", score: 5 });

    const latest = await latestSpanishAssessment(p.id);
    expect(latest?.term).toBe("Fall 2026");
    expect(latest?.score).toBe(5);
  });

  it("orders seasons within a year", async () => {
    const p = await person("Sam Rivera");
    await record({ personId: p.id, term: "Spring 2026", score: 3 });
    await record({ personId: p.id, term: "Fall 2026", score: 4 });

    expect((await latestSpanishAssessment(p.id))?.term).toBe("Fall 2026");
  });

  it("never lets an unparseable term win most-recent", async () => {
    const p = await person("Sam Rivera");
    await record({ personId: p.id, term: "Unknown", score: 1 });
    await record({ personId: p.id, term: "Spring 2015", score: 4 });

    expect((await latestSpanishAssessment(p.id))?.term).toBe("Spring 2015");
  });

  it("returns null for someone with no assessments", async () => {
    const p = await person("Never Assessed");
    expect(await latestSpanishAssessment(p.id)).toBeNull();
  });
});

describe("listAssessmentTerms", () => {
  it("lists each term once, newest first", async () => {
    await record({ term: "Spring 2015" });
    await record({ term: "Fall 2026" });
    await record({ term: "Fall 2026" });
    await record({ term: "Summer 2012" });

    expect(await listAssessmentTerms()).toEqual(["Fall 2026", "Spring 2015", "Summer 2012"]);
  });
});

describe("listSpanishAssessmentHistory", () => {
  it("prefers the linked Person's Hub name over the name the list carried", async () => {
    const p = await person("Samantha Rivera");
    await record({ personId: p.id, term: "Fall 2026", name: "Sam R." });

    const { rows } = await listSpanishAssessmentHistory({});
    expect(rows[0].displayName).toBe("Samantha Rivera");
  });

  it("falls back to the list's name when the row is not linked", async () => {
    await record({ term: "Fall 2026", name: "Unlinked Person" });
    const { rows } = await listSpanishAssessmentHistory({});
    expect(rows[0].displayName).toBe("Unlinked Person");
  });

  it("filters by term", async () => {
    await record({ term: "Fall 2026", name: "A" });
    await record({ term: "Spring 2015", name: "B" });

    const { rows, total } = await listSpanishAssessmentHistory({ term: "Spring 2015" });
    expect(total).toBe(1);
    expect(rows[0].displayName).toBe("B");
  });

  it("searches the linked person's name as well as the row's own fields", async () => {
    const p = await person("Findable Human");
    await record({ personId: p.id, term: "Fall 2026", name: null });

    const { total } = await listSpanishAssessmentHistory({ search: "findable" });
    expect(total).toBe(1);
  });

  it("paginates rather than returning every record since 2012", async () => {
    for (let i = 0; i < 55; i += 1) {
      await record({ term: "Fall 2026", name: `Person ${String(i).padStart(3, "0")}` });
    }

    const first = await listSpanishAssessmentHistory({ page: 1 });
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(55);
    expect(first.pageCount).toBe(2);

    const second = await listSpanishAssessmentHistory({ page: 2 });
    expect(second.rows).toHaveLength(5);
  });
});

describe("upsertSpanishAssessmentForTerm", () => {
  it("updates in place on a second write for the same term", async () => {
    const p = await person("Sam Rivera");
    await upsertSpanishAssessmentForTerm({ personId: p.id, term: "Fall 2026", score: 3, verified: true });
    await upsertSpanishAssessmentForTerm({ personId: p.id, term: "Fall 2026", score: 5, verified: true });

    const rows = await prisma.spanishAssessmentRecord.findMany({ where: { personId: p.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(5);
  });

  it("stamps a termRank so the row is orderable", async () => {
    const p = await person("Sam Rivera");
    await upsertSpanishAssessmentForTerm({ personId: p.id, term: "Fall 2026", score: 4, verified: true });

    const row = await prisma.spanishAssessmentRecord.findFirstOrThrow({ where: { personId: p.id } });
    expect(row.termRank).toBe(termRankOf("Fall 2026"));
    expect(row.termRank).toBeGreaterThan(0);
  });

  it("canonicalises the term label so a typed term matches an imported one", async () => {
    const p = await person("Sam Rivera");
    await record({ personId: p.id, term: "Fall 2026", score: 2 });
    await upsertSpanishAssessmentForTerm({ personId: p.id, term: " fall  2026 ", score: 4, verified: true });

    const rows = await prisma.spanishAssessmentRecord.findMany({ where: { personId: p.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(4);
  });
});

describe("updateSpanishAssessment", () => {
  it("edits score, modifier, and notes", async () => {
    const r = await record({ term: "Fall 2026", score: 2 });
    await updateSpanishAssessment({ id: r.id, score: 4, modifier: "minus", notes: "  reassessed  " });

    const after = await prisma.spanishAssessmentRecord.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.score).toBe(4);
    expect(after.modifier).toBe("minus");
    expect(after.notes).toBe("reassessed");
  });

  it("clears notes given only whitespace", async () => {
    const r = await record({ term: "Fall 2026", score: 2 });
    await updateSpanishAssessment({ id: r.id, score: 2, modifier: null, notes: "   " });

    const after = await prisma.spanishAssessmentRecord.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.notes).toBeNull();
  });
});

describe("addPersonToSpanishHistory", () => {
  it("adds an assessment found by NetID", async () => {
    const p = await person("Sam Rivera", { netId: "sr123" });
    await addPersonToSpanishHistory({
      netIdOrEmail: "SR123",
      term: "Fall 2026",
      score: 4,
      modifier: null,
    });

    const row = await prisma.spanishAssessmentRecord.findFirstOrThrow({ where: { personId: p.id } });
    expect(row.term).toBe("Fall 2026");
    expect(row.score).toBe(4);
    expect(row.termRank).toBe(termRankOf("Fall 2026"));
  });

  it("adds an assessment found by contact email", async () => {
    const p = await person("Sam Rivera", { contactEmail: "sam@example.edu" });
    await addPersonToSpanishHistory({
      netIdOrEmail: "SAM@example.edu",
      term: "Fall 2026",
      score: 3,
      modifier: "plus",
    });

    const row = await prisma.spanishAssessmentRecord.findFirstOrThrow({ where: { personId: p.id } });
    expect(row.modifier).toBe("plus");
  });

  // The previous version did a bare `return` on each of these, so the reviewer
  // saw a reset form and no indication anything had gone wrong.
  it("says so when nobody matches, rather than silently doing nothing", async () => {
    await expect(
      addPersonToSpanishHistory({ netIdOrEmail: "ghost", term: "Fall 2026", score: 4, modifier: null }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });

  it("says so when the person already has that term", async () => {
    const p = await person("Sam Rivera", { netId: "sr123" });
    await record({ personId: p.id, term: "Fall 2026", score: 4 });

    await expect(
      addPersonToSpanishHistory({ netIdOrEmail: "sr123", term: "Fall 2026", score: 5, modifier: null }),
    ).rejects.toThrow(/already has a Fall 2026 assessment/);
  });

  it("rejects a term label it cannot rank", async () => {
    await person("Sam Rivera", { netId: "sr123" });
    await expect(
      addPersonToSpanishHistory({ netIdOrEmail: "sr123", term: "Autumn 2026", score: 4, modifier: null }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });

  it("rejects an empty identifier", async () => {
    await expect(
      addPersonToSpanishHistory({ netIdOrEmail: "  ", term: "Fall 2026", score: 4, modifier: null }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });
});

describe("linkSpanishAssessmentToPerson", () => {
  it("attaches an imported row to a Hub account and adopts their name", async () => {
    const p = await person("Samantha Rivera", { netId: "sr123" });
    const r = await record({ term: "Spring 2015", name: "Sam R.", score: 4 });

    await linkSpanishAssessmentToPerson({ id: r.id, netIdOrEmail: "sr123" });

    const after = await prisma.spanishAssessmentRecord.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.personId).toBe(p.id);
    expect(after.name).toBe("Samantha Rivera");
  });

  it("refuses when that person already has a record for the same term", async () => {
    const p = await person("Samantha Rivera", { netId: "sr123" });
    await record({ personId: p.id, term: "Spring 2015", score: 5 });
    const dupe = await record({ term: "Spring 2015", name: "Sam R.", score: 4 });

    await expect(
      linkSpanishAssessmentToPerson({ id: dupe.id, netIdOrEmail: "sr123" }),
    ).rejects.toThrow(/already has a Spring 2015 assessment/);
  });

  it("reports an unknown identifier", async () => {
    const r = await record({ term: "Spring 2015", name: "Sam R." });
    await expect(
      linkSpanishAssessmentToPerson({ id: r.id, netIdOrEmail: "nobody" }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });
});

describe("listSpanishFlagMismatches", () => {
  async function verifiedSpanishSpeaker(name: string, score: number | null) {
    const p = await person(name);
    await prisma.personLanguage.create({
      data: {
        personId: p.id,
        language: "es",
        verified: true,
        verifiedAt: new Date(),
        score,
      },
    });
    return p;
  }

  it("lists a verified speaker with no assessment on record at all", async () => {
    const p = await verifiedSpanishSpeaker("Unassessed Speaker", null);

    const out = await listSpanishFlagMismatches();
    expect(out).toHaveLength(1);
    expect(out[0].personId).toBe(p.id);
    expect(out[0].reason).toBe("no-assessment");
  });

  it("lists a verified speaker whose newest score is below the clinic-wide bar", async () => {
    const p = await verifiedSpanishSpeaker("Conversational Speaker", null);
    await record({ personId: p.id, term: "Fall 2026", score: 3 });

    const out = await listSpanishFlagMismatches();
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("below-interpreter-bar");
    expect(out[0].score).toBe(3);
    expect(out[0].term).toBe("Fall 2026");
  });

  it("clears someone whose newest score meets the bar even if an older one did not", async () => {
    const p = await verifiedSpanishSpeaker("Improved Speaker", null);
    await record({ personId: p.id, term: "Spring 2015", score: 2 });
    await record({ personId: p.id, term: "Fall 2026", score: CLINIC_WIDE_INTERPRETER_MIN_SCORE });

    expect(await listSpanishFlagMismatches()).toEqual([]);
  });

  it("counts a score recorded on the claim itself as an assessment", async () => {
    // Someone scored in Hub before the historical import ran has no history row,
    // and must not read as "never assessed".
    await verifiedSpanishSpeaker("Scored In Hub", 5);
    expect(await listSpanishFlagMismatches()).toEqual([]);
  });

  it("ignores unverified claims: the queue owns those, not the cross-check", async () => {
    const p = await person("Merely Claimed");
    await prisma.personLanguage.create({
      data: { personId: p.id, language: "es", selfReported: true },
    });

    expect(await listSpanishFlagMismatches()).toEqual([]);
  });

  it("ignores offboarded people", async () => {
    const p = await prisma.person.create({ data: { name: "Gone", status: "OFFBOARDED" } });
    await prisma.personLanguage.create({
      data: { personId: p.id, language: "es", verified: true, verifiedAt: new Date() },
    });

    expect(await listSpanishFlagMismatches()).toEqual([]);
  });

  it("ignores a verified language that is not Spanish", async () => {
    const p = await person("Portuguese Speaker");
    await prisma.personLanguage.create({
      data: { personId: p.id, language: "pt", verified: true, verifiedAt: new Date() },
    });

    expect(await listSpanishFlagMismatches()).toEqual([]);
  });

  // The row has to answer "should I pull this flag?", and the answer depends on
  // who the person actually works for: PATS staffing conversational speakers is
  // the whole reason a 3 is not automatically wrong.
  describe("departments that would still staff them", () => {
    async function activeTerm() {
      return prisma.term.create({
        data: {
          code: "FA26",
          name: "Fall 2026",
          status: "ACTIVE",
          startDate: new Date("2026-09-01"),
          endDate: new Date("2026-12-31"),
        },
      });
    }

    async function memberOf(
      personId: string,
      termId: string,
      code: string,
      minInterpreterScore: number | null,
    ) {
      const dept = await prisma.department.create({
        data: { code, name: `Dept ${code}`, minInterpreterScore },
      });
      await prisma.termMembership.create({
        data: { personId, termId, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      });
    }

    it("names a department whose own bar the score clears", async () => {
      const t = await activeTerm();
      const p = await verifiedSpanishSpeaker("Conversational", null);
      await record({ personId: p.id, term: "Fall 2026", score: 3 });
      await memberOf(p.id, t.id, "PATS", 3);

      const [row] = await listSpanishFlagMismatches();
      expect(row.acceptedByDepartments).toEqual(["PATS"]);
    });

    it("leaves out a department still on the clinic-wide bar", async () => {
      const t = await activeTerm();
      const p = await verifiedSpanishSpeaker("Conversational", null);
      await record({ personId: p.id, term: "Fall 2026", score: 3 });
      await memberOf(p.id, t.id, "MEDS", null);

      const [row] = await listSpanishFlagMismatches();
      expect(row.acceptedByDepartments).toEqual([]);
    });

    it("lists only the accepting half when the person spans both", async () => {
      const t = await activeTerm();
      const p = await verifiedSpanishSpeaker("Two Departments", null);
      await record({ personId: p.id, term: "Fall 2026", score: 3 });
      await memberOf(p.id, t.id, "PATS", 3);
      await memberOf(p.id, t.id, "MEDS", null);

      const [row] = await listSpanishFlagMismatches();
      expect(row.acceptedByDepartments).toEqual(["PATS"]);
    });

    it("names nobody for a missing assessment, whatever the bars say", async () => {
      const t = await activeTerm();
      const p = await verifiedSpanishSpeaker("Unassessed", null);
      await memberOf(p.id, t.id, "PATS", 1);

      const [row] = await listSpanishFlagMismatches();
      expect(row.reason).toBe("no-assessment");
      expect(row.acceptedByDepartments).toEqual([]);
    });
  });
});

describe("history stays consistent with the queue", () => {
  it("recording an assessment files a history row for the active term", async () => {
    await actor();
    const p = await person("Sam Rivera");
    await prisma.term.create({
      data: {
        code: "FA26",
        name: "Fall 2026",
        status: "ACTIVE",
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-12-31"),
      },
    });

    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: 4,
    });

    const row = await prisma.spanishAssessmentRecord.findFirstOrThrow({ where: { personId: p.id } });
    expect(row.term).toBe("Fall 2026");
    expect(row.score).toBe(4);
    expect(row.verified).toBe(true);
    expect(row.termRank).toBe(termRankOf("Fall 2026"));

    // And the denormalized copy the badge and scheduling read agrees with it.
    const claim = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(claim.score).toBe(4);
  });

  // The end-to-end assertion the feature shipped without: a half step selected
  // in the UI has to survive normalizeScore, the recordLanguageAssessment guard,
  // and both columns. Each of those three rejected or truncated it independently,
  // so any one of them left in place makes this fail.
  it("records a half step to both stores without rounding it", async () => {
    await actor();
    const p = await person("Sam Rivera");
    await prisma.term.create({
      data: {
        code: "FA26",
        name: "Fall 2026",
        status: "ACTIVE",
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-12-31"),
      },
    });

    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: normalizeScore("3.5"),
    });

    const row = await prisma.spanishAssessmentRecord.findFirstOrThrow({ where: { personId: p.id } });
    expect(row.score).toBe(3.5);

    const claim = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(claim.score).toBe(3.5);
  });

  it("refuses a score off the scale rather than storing it", async () => {
    await actor();
    const p = await person("Sam Rivera");

    await expect(
      recordLanguageAssessment(ACTOR, {
        personId: p.id,
        language: "es",
        verified: true,
        score: 3.25,
      }),
    ).rejects.toBeInstanceOf(LanguageValidationError);

    expect(await prisma.personLanguage.count()).toBe(0);
  });

  it("does not blow up when there is no active term to file under", async () => {
    await actor();
    const p = await person("Sam Rivera");

    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: 4,
    });

    const claim = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(claim.score).toBe(4);
    expect(await prisma.spanishAssessmentRecord.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyHistoricalAssessment
// ---------------------------------------------------------------------------

/**
 * The history tab's Verify button. Every test here pins one of the three
 * defects the old version shipped with, all three of which reached production
 * and one of which was destructive.
 *
 * The old button posted a personId and called recordLanguageAssessment, so it
 * was rendered against a row's own verdict and wrote the person's live flag.
 */
describe("verifyHistoricalAssessment", () => {
  it("verifies the row that was clicked, so the badge and the button change", async () => {
    await actor();
    const p = await person("Rosa Delgado");
    const old = await record({ personId: p.id, term: "Fall 2024", score: 5 });

    await verifyHistoricalAssessment(ACTOR, { recordId: old.id, verified: true });

    // Defect 1: the clicked row's own `verified` was never touched, so it kept
    // showing no badge and kept offering Verify however many times it was pressed.
    const after = await prisma.spanishAssessmentRecord.findUniqueOrThrow({
      where: { id: old.id },
    });
    expect(after.verified).toBe(true);
  });

  it("creates no record in any other term", async () => {
    await actor();
    const p = await person("Rosa Delgado");
    // An ACTIVE term has to exist for this test to mean anything: it is the
    // term the old code mirrored into, so without one the fabrication could not
    // happen and the assertion below would pass for the wrong reason.
    await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        status: "ACTIVE",
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-08-31"),
      },
    });
    const old = await record({ personId: p.id, term: "Fall 2024", score: 5 });

    await verifyHistoricalAssessment(ACTOR, { recordId: old.id, verified: true });

    // Defect 2, and the one that corrupted data rather than merely confusing a
    // reviewer. recordLanguageAssessment mirrors into the ACTIVE term, so
    // verifying a Fall 2024 row invented a Summer 2026 assessment -- which then
    // outranked the real one on the member's profile (latestSpanishAssessment
    // orders on termRank) and carried no score, so a genuine 5 read as none.
    const all = await prisma.spanishAssessmentRecord.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].term).toBe("Fall 2024");
    expect((await latestSpanishAssessment(p.id))?.score).toBe(5);
  });

  it("syncs the live flag from the record's own score when it is the newest", async () => {
    await actor();
    const p = await person("Rosa Delgado");
    const newest = await record({ personId: p.id, term: "Spring 2026", score: 4 });

    const result = await verifyHistoricalAssessment(ACTOR, {
      recordId: newest.id,
      verified: true,
    });

    expect(result.liveFlagUpdated).toBe(true);
    // The RECORD's score, not null. The old path passed no score at all, which
    // blanked whatever was on file.
    const claim = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(claim.verified).toBe(true);
    expect(claim.score).toBe(4);
    expect(claim.verifiedAt).not.toBeNull();
  });

  it("upserts a live flag for an alum who has none yet", async () => {
    // The workflow this button legitimately serves: a returning alum whose
    // historical record has just been linked has no PersonLanguage row at all.
    await actor();
    const p = await person("Vera Ochoa");
    const only = await record({ personId: p.id, term: "Fall 2019", score: 5 });

    await verifyHistoricalAssessment(ACTOR, { recordId: only.id, verified: true });

    const claim = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(claim.score).toBe(5);
  });

  // ---- THE DESTRUCTIVE ONE -------------------------------------------------
  //
  // Defect 3. verifiedLanguagesByPerson gates scheduling, capacity, badges and
  // the passport on PersonLanguage.verified, so "Not verified" on someone's
  // 2019 row pulled a CURRENT member out of the interpreter pool. Both halves
  // are asserted, because a version that simply stopped writing PersonLanguage
  // would pass the first and fail the "newest" tests above.

  it("does not touch the live flag from an OLDER record", async () => {
    await actor();
    const p = await person("Rosa Delgado");
    await record({ personId: p.id, term: "Spring 2026", score: 5 });
    const stale = await record({ personId: p.id, term: "Fall 2019", score: 2 });
    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: 5,
    });

    const result = await verifyHistoricalAssessment(ACTOR, {
      recordId: stale.id,
      verified: false,
    });

    expect(result.liveFlagUpdated).toBe(false);
    // Still a verified 5. A verdict about 2019 is a statement about 2019.
    const claim = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(claim.verified).toBe(true);
    expect(claim.score).toBe(5);
    // The old row still records the verdict that was actually given.
    expect(
      (await prisma.spanishAssessmentRecord.findUniqueOrThrow({ where: { id: stale.id } }))
        .verified,
    ).toBe(false);
  });

  it("records the verdict on an unlinked row without inventing a person to apply it to", async () => {
    await actor();
    const orphan = await record({ personId: null, term: "Fall 2016", score: 3, name: "A. Lum" });

    const result = await verifyHistoricalAssessment(ACTOR, {
      recordId: orphan.id,
      verified: true,
    });

    expect(result.liveFlagUpdated).toBe(false);
    expect(await prisma.personLanguage.count()).toBe(0);
    expect(
      (await prisma.spanishAssessmentRecord.findUniqueOrThrow({ where: { id: orphan.id } }))
        .verified,
    ).toBe(true);
  });

  it("refuses a record id that no longer exists rather than reporting success", async () => {
    await actor();
    await expect(
      verifyHistoricalAssessment(ACTOR, { recordId: "gone", verified: true }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });
});
