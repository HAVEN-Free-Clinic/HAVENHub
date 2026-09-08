import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { priorLanguageVerdicts } from "./applicant-review";

beforeEach(resetDb);

/** A cycle plus one applicant in it, identified by email. */
async function applicantIn(cycleTitle: string, email: string, personId?: string) {
  const lead = await prisma.person.create({ data: { name: "Lead" } });
  const term = await prisma.term.create({
    data: {
      code: `T${Math.random().toString(36).slice(2, 6)}`, name: "Term",
      startDate: new Date(), endDate: new Date(), status: "ACTIVE", clinicDates: [],
    },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: cycleTitle,
      publicSlug: `s-${Math.random()}`, departments: ["PATS"],
      createdById: lead.id, status: "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace",
      email, emailLower: email.toLowerCase(), applicantPersonId: personId ?? null,
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {},
      applicantType: "NEW", departmentChoices: ["PATS"],
    },
  });
  return { cycle, applicant, application };
}

describe("priorLanguageVerdicts", () => {
  it("finds a verified PersonLanguage row through a linked person", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.personLanguage.create({
      data: {
        personId: person.id, language: "es", verified: true,
        verifiedAt: new Date("2026-01-01"), verifiedById: "assessor", score: 4,
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")).toMatchObject({
      verified: true, score: 4, source: "member",
    });
  });

  // A recorded "no" settles the question exactly as it does in the member
  // queue, where a "no" stamps verifiedAt and removes the row for good.
  it("treats a recorded no as a verdict on file", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.personLanguage.create({
      data: {
        personId: person.id, language: "es", verified: false,
        verifiedAt: new Date("2026-01-01"), verifiedById: "assessor",
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")?.verified).toBe(false);
  });

  // The member queue filters on status ACTIVE because it is deciding whose
  // worklist a MEMBER belongs on. This is a different question: an alum
  // reapplying still has their assessment on file.
  it("finds a verdict on an OFFBOARDED person", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace", status: "OFFBOARDED" } });
    await prisma.personLanguage.create({
      data: {
        personId: person.id, language: "es", verified: true,
        verifiedAt: new Date("2026-01-01"), verifiedById: "assessor", score: 5,
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")?.score).toBe(5);
  });

  // A claim is not a verdict. verifiedAt IS NULL is exactly the state that puts
  // someone IN the queue, so it must never keep them out of it.
  it("does not treat an unassessed claim as a verdict", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.personLanguage.create({
      data: { personId: person.id, language: "es", selfReported: true },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")).toBeUndefined();
  });

  // The case with no Person at all: a rejected applicant reapplying next year.
  it("finds a prior cycle's application verdict by email, with no person anywhere", async () => {
    const last = await applicantIn("Fall 2025", "ada@yale.edu");
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: last.application.id, language: "es", verified: true,
        verifiedById: "assessor", score: 3, verifiedAt: new Date("2025-09-01"),
      },
    });
    const now = await applicantIn("Fall 2026", "Ada@Yale.edu");

    const map = await priorLanguageVerdicts([now.applicant.id]);

    expect(map.get(now.applicant.id)?.get("es")).toMatchObject({
      verified: true, score: 3, source: "application",
    });
  });

  it("finds a SpanishAssessmentRecord linked to the resolved person", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.spanishAssessmentRecord.create({
      data: {
        email: "", name: "Ada Lovelace", personId: person.id,
        term: "Spring 2019", termRank: 20191, score: 4, verified: true,
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")).toMatchObject({
      score: 4, source: "history", term: "Spring 2019",
    });
  });

  it("returns an empty map for an applicant with nothing on file", async () => {
    const { applicant } = await applicantIn("Fall 2026", "nobody@yale.edu");

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.size ?? 0).toBe(0);
  });
});
