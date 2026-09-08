import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { listApplicantLanguageQueue, priorLanguageVerdicts } from "./applicant-review";

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

    expect(map.has(applicant.id)).toBe(true);
    expect(map.get(applicant.id)!.size).toBe(0);
  });

  // A re-import (scripts/import-spanish-assessments.ts, documented safe to
  // re-run) upserts and bumps updatedAt on every matching row regardless of
  // which term it represents. termRank, not updatedAt, is the only signal
  // that says which of a person's assessment rows is the newest term.
  it("orders history by termRank rather than updatedAt, so a re-import cannot outrank a newer term", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.spanishAssessmentRecord.create({
      data: {
        email: "", name: "Ada Lovelace", personId: person.id,
        term: "Spring 2019", termRank: 20191, score: 3, verified: true,
        updatedAt: new Date("2026-06-01"),
      },
    });
    await prisma.spanishAssessmentRecord.create({
      data: {
        email: "", name: "Ada Lovelace", personId: person.id,
        term: "Fall 2024", termRank: 20243, score: 5, verified: true,
        updatedAt: new Date("2020-01-01"),
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")).toMatchObject({
      score: 5, term: "Fall 2024", source: "history",
    });
  });

  // History is a fallback, not a competitor. PersonLanguage is the current
  // authoritative record (the badge backfill copies history INTO it), so a
  // live member verdict must win even when a history row's updatedAt is
  // newer, which is exactly what a re-import produces.
  it("keeps the member verdict over a history row with a newer updatedAt", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.personLanguage.create({
      data: {
        personId: person.id, language: "es", verified: true,
        verifiedAt: new Date("2020-01-01"), verifiedById: "assessor", score: 4,
      },
    });
    await prisma.spanishAssessmentRecord.create({
      data: {
        email: "", name: "Ada Lovelace", personId: person.id,
        term: "Spring 2019", termRank: 20191, score: 2, verified: true,
        updatedAt: new Date("2026-06-01"),
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")).toMatchObject({
      score: 4, source: "member",
    });
  });
});

/** A flagged department, an unflagged one, a term, a cycle, and a lead. */
async function lane() {
  const lead = await prisma.person.create({ data: { name: "Lead" } });
  const [pats, educ] = await Promise.all([
    prisma.department.create({
      data: { code: "PATS", name: "Patient Services", assessLanguageBeforeAcceptance: true },
    }),
    prisma.department.create({ data: { code: "EDUC", name: "Education" } }),
  ]);
  const term = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(),
      status: "ACTIVE", clinicDates: [],
    },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Fall 2026 Volunteers",
      publicSlug: `s-${Math.random()}`, departments: ["PATS", "EDUC"],
      createdById: lead.id, status: "OPEN",
    },
  });
  return { lead, pats, educ, term, cycle };
}

/** One submitted application in the seeded cycle. */
async function apply(
  ctx: Awaited<ReturnType<typeof lane>>,
  email: string,
  overrides: Record<string, unknown> = {},
) {
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: ctx.cycle.id, firstName: "Ada", lastName: "Lovelace",
      email, emailLower: email.toLowerCase(),
    },
  });
  const application = await prisma.application.create({
    // The cast is load-bearing: `overrides` is an open record so the spread
    // cannot be narrowed to Prisma's generated create input. Each test supplies
    // real column names, and a typo surfaces immediately as a failing assertion.
    data: {
      cycleId: ctx.cycle.id, applicantId: applicant.id, answers: {},
      applicantType: "NEW", departmentChoices: ["PATS"],
      status: "SUBMITTED", submittedAt: new Date(),
      ...overrides,
    } as never,
  });
  return { applicant, application };
}

describe("listApplicantLanguageQueue", () => {
  it("queues Spanish for a flagged-department applicant who claimed nothing", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu");

    const rows = await listApplicantLanguageQueue();

    expect(rows.map((r) => r.language)).toEqual(["es"]);
    expect(rows[0].cycleTitle).toBe("Fall 2026 Volunteers");
    expect(rows[0].departments).toEqual(["PATS"]);
  });

  it("queues every other language the applicant claimed alongside Spanish", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu", { languagesClaimed: ["fr", "ht"] });

    const rows = await listApplicantLanguageQueue();

    expect(rows.map((r) => r.language).sort()).toEqual(["es", "fr", "ht"]);
  });

  it("ignores an applicant to an unflagged department", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu", { departmentChoices: ["EDUC"] });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  it("queues a dual-role offer to a flagged department from an unflagged primary", async () => {
    const ctx = await lane();
    await prisma.department.create({
      data: { code: "INTP", name: "Interpreting", assessLanguageBeforeAcceptance: true },
    });
    await apply(ctx, "ada@yale.edu", {
      departmentChoices: ["EDUC"], dualRoleDepartments: ["INTP"],
    });

    const rows = await listApplicantLanguageQueue();

    expect(rows).toHaveLength(1);
    expect(rows[0].dualRoleDepartments).toEqual(["INTP"]);
  });

  it("ignores a withdrawn application", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu", { status: "WITHDRAWN", withdrawnAt: new Date() });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  it("ignores an application in an ARCHIVED cycle", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu");
    await prisma.recruitmentCycle.update({
      where: { id: ctx.cycle.id }, data: { status: "ARCHIVED" },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  it("ignores a volunteer application the department has already decided", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");
    await prisma.application.update({
      where: { id: application.id }, data: { decision: "REJECT", decidedAt: new Date() },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  // The regression the second decided-clause exists for. A DIRECTOR-track
  // application is decided on Interview.decision and its Application.decision
  // stays PENDING forever, so testing only the latter parks every decided
  // director applicant in the queue permanently.
  it("ignores a director application decided on its interview", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");
    // Interview.createdById is required and non-defaulted: without it Prisma
    // rejects the row before the query under test ever runs.
    await prisma.interview.create({
      data: {
        applicationId: application.id, departmentCode: "PATS",
        decision: "ACCEPT", scheduledAt: new Date(), createdById: ctx.lead.id,
      },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  // Interview rows are per (applicationId, departmentCode): a director
  // applicant ranked into both a lane department and a non-lane one can have
  // the non-lane department decide first. That must not drop the application
  // out of the queue while the lane department's own verdict is still open.
  it("keeps an in-lane applicant queued when only a non-lane interview has been decided", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu", {
      departmentChoices: ["PATS", "EDUC"],
    });
    await prisma.interview.create({
      data: {
        applicationId: application.id, departmentCode: "EDUC",
        decision: "REJECT", scheduledAt: new Date(), createdById: ctx.lead.id,
      },
    });

    const rows = await listApplicantLanguageQueue();

    expect(rows.map((r) => r.language)).toEqual(["es"]);
  });

  it("ignores an accepted application", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");
    await prisma.acceptance.create({
      data: { applicationId: application.id, departmentCode: "PATS", approvedById: ctx.lead.id },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  it("drops a language already assessed on this application", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu", { languagesClaimed: ["fr"] });
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: application.id, language: "es",
        verified: true, verifiedById: ctx.lead.id, score: 4,
      },
    });

    const rows = await listApplicantLanguageQueue();

    expect(rows.map((r) => r.language)).toEqual(["fr"]);
  });

  it("drops a language with a verdict on file from a previous life", async () => {
    const ctx = await lane();
    const person = await prisma.person.create({ data: { name: "Ada Lovelace", status: "OFFBOARDED" } });
    await prisma.personLanguage.create({
      data: {
        personId: person.id, language: "es", verified: true,
        verifiedAt: new Date("2025-01-01"), verifiedById: ctx.lead.id, score: 5,
      },
    });
    const applicant = await prisma.applicant.create({
      data: {
        cycleId: ctx.cycle.id, firstName: "Ada", lastName: "Lovelace",
        email: "ada@yale.edu", emailLower: "ada@yale.edu", applicantPersonId: person.id,
      },
    });
    await prisma.application.create({
      data: {
        cycleId: ctx.cycle.id, applicantId: applicant.id, answers: {},
        applicantType: "NEW", departmentChoices: ["PATS"],
        status: "SUBMITTED", submittedAt: new Date(),
      },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });
});
