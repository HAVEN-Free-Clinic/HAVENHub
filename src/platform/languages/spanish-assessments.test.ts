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
import { recordLanguageAssessment } from "./index";
import {
  addPersonToSpanishHistory,
  latestSpanishAssessment,
  linkSpanishAssessmentToPerson,
  listAssessmentTerms,
  listSpanishAssessmentHistory,
  listSpanishFlagMismatches,
  normalizeModifier,
  normalizeScore,
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
