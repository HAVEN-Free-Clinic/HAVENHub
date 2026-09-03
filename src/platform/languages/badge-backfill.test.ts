import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { termRankOf } from "./assessment-terms";
import { backfillLanguageBadges } from "./badge-backfill";

beforeEach(resetDb);

async function person(name: string, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, status } });
}

async function record(
  personId: string | null,
  term: string,
  score: number | null,
) {
  return prisma.spanishAssessmentRecord.create({
    data: { email: "", personId, term, termRank: termRankOf(term), score },
  });
}

async function esRow(personId: string) {
  return prisma.personLanguage.findUnique({
    where: { personId_language: { personId, language: "es" } },
  });
}

describe("backfillLanguageBadges", () => {
  it("badges a person scored at the top of the scale", async () => {
    const p = await person("Native Speaker");
    await record(p.id, "Fall 2024", 5);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts.badged).toBe(1);
    const row = await esRow(p.id);
    expect(row?.verified).toBe(true);
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.score).toBe(5);
  });

  // The note this backfill writes is rendered verbatim to the volunteer on
  // their own /my-info page. The 1-5 score is INTERNAL and must never reach
  // the person it describes, so pin that no digit ever lands in the note.
  // Term deliberately carries no year here: the note also names the term, and
  // a year would put a digit in the note for a reason unrelated to the one
  // this test exists to catch.
  it("never lets the internal score leak into the member-facing note", async () => {
    const p = await person("Note Check");
    await record(p.id, "Assessment Term", 5);

    await backfillLanguageBadges({ dryRun: false });

    const row = await esRow(p.id);
    expect(row?.note).not.toMatch(/\d/);
  });

  it("badges a 3, the conversational floor", async () => {
    const p = await person("Conversational");
    await record(p.id, "Fall 2024", 3);

    await backfillLanguageBadges({ dryRun: false });

    const row = await esRow(p.id);
    expect(row?.verified).toBe(true);
    expect(row?.score).toBe(3);
  });

  // A 2 is a real assessment. It must settle the question (verifiedAt stamped,
  // so they leave the queue) without handing out a badge the roster would act on.
  it("settles a 2 as not verified, keeping the score on file", async () => {
    const p = await person("Some Spanish");
    await record(p.id, "Fall 2024", 2);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts.settled).toBe(1);
    const row = await esRow(p.id);
    expect(row?.verified).toBe(false);
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.score).toBe(2);
  });

  // The self-reported claim intake creates (verified: false, verifiedAt: null)
  // is the live path for most affected people: the update branch of the
  // upsert, not the create branch. It must badge them, and it must not
  // clobber the fact that they claimed the language themselves.
  it("badges a person who already has a self-reported unverified claim", async () => {
    const p = await person("Self Reported High");
    await record(p.id, "Fall 2024", 5);
    await prisma.personLanguage.create({
      data: { personId: p.id, language: "es", selfReported: true, verified: false, verifiedAt: null },
    });

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts.badged).toBe(1);
    const row = await esRow(p.id);
    expect(row?.verified).toBe(true);
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.score).toBe(5);
    expect(row?.selfReported).toBe(true);
  });

  it("settles a person who already has a self-reported unverified claim", async () => {
    const p = await person("Self Reported Low");
    await record(p.id, "Fall 2024", 2);
    await prisma.personLanguage.create({
      data: { personId: p.id, language: "es", selfReported: true, verified: false, verifiedAt: null },
    });

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts.settled).toBe(1);
    const row = await esRow(p.id);
    expect(row?.verified).toBe(false);
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.score).toBe(2);
    expect(row?.selfReported).toBe(true);
  });

  it("skips a person whose only record carries no score", async () => {
    const p = await person("Assessed No Number");
    await record(p.id, "Fall 2015", null);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts["no-score"]).toBe(1);
    expect(await esRow(p.id)).toBeNull();
  });

  // A later scoreless row records that an assessment happened, not that the
  // earlier score was withdrawn.
  it("uses the most recent SCORED record when a later record has no score", async () => {
    const p = await person("Scored Then Not");
    await record(p.id, "Fall 2018", 4);
    await record(p.id, "Fall 2024", null);

    await backfillLanguageBadges({ dryRun: false });

    const row = await esRow(p.id);
    expect(row?.verified).toBe(true);
    expect(row?.score).toBe(4);
  });

  it("prefers the newest score when several are on file", async () => {
    const p = await person("Improved");
    await record(p.id, "Fall 2018", 3);
    await record(p.id, "Spring 2026", 5);

    await backfillLanguageBadges({ dryRun: false });

    expect((await esRow(p.id))?.score).toBe(5);
  });

  // A reviewer ruled in Hub. A 2014 spreadsheet row must not reverse them.
  it("never reverses a reviewer's verdict, and fills only a missing score", async () => {
    const p = await person("Already Assessed");
    await record(p.id, "Fall 2024", 5);
    await prisma.personLanguage.create({
      data: {
        personId: p.id,
        language: "es",
        verified: false,
        verifiedAt: new Date("2026-08-20"),
        score: null,
      },
    });

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts["score-filled"]).toBe(1);
    const row = await esRow(p.id);
    expect(row?.verified).toBe(false);
    expect(row?.score).toBe(5);
  });

  it("leaves an assessed row that already has a score completely alone", async () => {
    const p = await person("Fully Assessed");
    await record(p.id, "Fall 2024", 5);
    const assessedAt = new Date("2026-08-20");
    await prisma.personLanguage.create({
      data: { personId: p.id, language: "es", verified: true, verifiedAt: assessedAt, score: 3 },
    });

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.counts.unchanged).toBe(1);
    const row = await esRow(p.id);
    expect(row?.score).toBe(3);
    expect(row?.verifiedAt).toEqual(assessedAt);
  });

  it("counts an unlinked record and never guesses at a person for it", async () => {
    await record(null, "Fall 2016", 5);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.unlinkedRecords).toBe(1);
    expect(report.rows).toHaveLength(0);
    expect(await prisma.personLanguage.count()).toBe(0);
  });

  it("ignores people who are no longer active", async () => {
    const p = await person("Alum", "OFFBOARDED");
    await record(p.id, "Fall 2024", 5);

    const report = await backfillLanguageBadges({ dryRun: false });

    expect(report.rows).toHaveLength(0);
    expect(await esRow(p.id)).toBeNull();
  });

  it("writes nothing on a dry run but reports what it would do", async () => {
    const p = await person("Dry Run");
    await record(p.id, "Fall 2024", 5);

    const report = await backfillLanguageBadges({ dryRun: true });

    expect(report.counts.badged).toBe(1);
    expect(await esRow(p.id)).toBeNull();
  });

  // The only other writer of PersonLanguage.verified (recordLanguageAssessment)
  // audits every write. This backfill flips the same field for dozens of
  // people and must leave the same kind of trail, under its own action name
  // so a "who badged this person" search can tell a human review from this
  // one-time run.
  it("audits a badged person, with no actor", async () => {
    const p = await person("Audited Badge");
    await record(p.id, "Fall 2024", 5);

    await backfillLanguageBadges({ dryRun: false });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: "person.language_backfill", entityId: p.id },
    });
    expect(entry.actorPersonId).toBeNull();
    expect((entry.after as Record<string, unknown>).verified).toBe(true);
    expect((entry.after as Record<string, unknown>).score).toBe(5);
    expect((entry.after as Record<string, unknown>).term).toBe("Fall 2024");
  });

  it("writes no audit rows on a dry run", async () => {
    const p = await person("Dry Run Audit");
    await record(p.id, "Fall 2024", 5);

    await backfillLanguageBadges({ dryRun: true });

    expect(
      await prisma.auditLog.count({ where: { action: "person.language_backfill" } }),
    ).toBe(0);
  });

  // Re-running after reviewers have worked the queue must be a no-op on
  // everything they touched.
  it("is idempotent: a second run changes nothing", async () => {
    const p = await person("Twice");
    await record(p.id, "Fall 2024", 5);

    await backfillLanguageBadges({ dryRun: false });
    const first = await esRow(p.id);
    const second = await backfillLanguageBadges({ dryRun: false });

    expect(second.counts.badged).toBe(0);
    expect(second.counts.unchanged).toBe(1);
    expect((await esRow(p.id))?.verifiedAt).toEqual(first?.verifiedAt);
  });
});
