import { randomBytes } from "node:crypto";
import type { Prisma, RecruitmentCycle } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";

/**
 * Test runs: a throwaway copy of a cycle that recruitment can walk through with
 * made-up applicants before the real one goes out.
 *
 * What a copy carries over is everything that defines how the cycle looks and
 * behaves: the application form (sections and fields), the per-cycle email
 * overrides, the onboarding contract layout, the scorer pool and the cycle's
 * settings. What it never carries is anything about people: no applicants,
 * applications, invites, training or attendance. It starts as a DRAFT with no
 * application window, so the tester publishes it themselves, which rehearses
 * that step too.
 *
 * What keeps a test run from touching anything real lives where each effect
 * happens, keyed off RecruitmentCycle.isTest:
 *   - the public apply listing, the welcome count, upcoming cycles and the MCP
 *     cycle list skip it, so only someone with the link can reach the form;
 *   - the reviewer digest skips it, so directors are not pinged about fake people;
 *   - every cycle email gets a "[TEST]" subject prefix (email/render.ts);
 *   - it can never be the term's training cycle (training.ts), which keeps it out
 *     of training standing, clearance and the makeup course;
 *   - its acceptances never show as incoming in a schedule builder
 *     (liveAcceptanceWhere), and promotion refuses it, so nobody reaches the roster.
 */

export class TestCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestCycleError";
  }
}

export const TEST_TITLE_PREFIX = "[TEST] ";

/** Six lowercase hex characters, enough that two test runs of the same cycle
 *  never collide on the unique public link. */
function slugSuffix(): string {
  return randomBytes(3).toString("hex");
}

/** Prisma reads a nullable Json column back as null; writing undefined leaves
 *  the new column NULL too, which is the same thing. */
function json(value: Prisma.JsonValue | null): Prisma.InputJsonValue | undefined {
  return (value ?? undefined) as Prisma.InputJsonValue | undefined;
}

export async function createTestCycle(sourceId: string, actorId: string): Promise<RecruitmentCycle> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new TestCycleError("Only recruitment leads can start a test run.");
  }
  const source = await prisma.recruitmentCycle.findUnique({
    where: { id: sourceId },
    include: {
      // Read raw, not through loadCycle: that resolves availability options
      // against the clinic calendar for display, and the copy must store what
      // the source stored, not a rendering of it.
      sections: { include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
      cycleEmails: true,
      contract: true,
      scorers: { select: { personId: true } },
    },
  });
  if (!source) throw new TestCycleError("Cycle not found.");
  if (source.isTest) throw new TestCycleError("This is already a test run. Start a new one from the real cycle.");

  const title = `${TEST_TITLE_PREFIX}${source.title}`;
  const publicSlug = `${source.publicSlug}-test-${slugSuffix()}`;

  const copy = await prisma.$transaction(
    async (tx) => {
      const created = await tx.recruitmentCycle.create({
        data: {
          track: source.track,
          termId: source.termId,
          title,
          publicSlug,
          departments: source.departments,
          acceptsRenewals: source.acceptsRenewals,
          quizPassPercent: source.quizPassPercent,
          quizMaxAttempts: source.quizMaxAttempts,
          trainingLocation: source.trainingLocation,
          inPersonTrainingDate: source.inPersonTrainingDate,
          routeTopPercent: source.routeTopPercent,
          routeBottomPercent: source.routeBottomPercent,
          scoresPerApplication: source.scoresPerApplication,
          isTest: true,
          testSourceCycleId: source.id,
          createdById: actorId,
          // Left at their defaults on purpose: status DRAFT, no application
          // window, isTermTraining false, nothing released.
        },
      });

      // Sections one at a time, because each field needs its new section's id.
      for (const section of source.sections) {
        const newSection = await tx.formSection.create({
          data: {
            cycleId: created.id,
            title: section.title,
            description: section.description,
            order: section.order,
            departmentCode: section.departmentCode,
            appliesTo: section.appliesTo,
            purpose: section.purpose,
          },
        });
        if (section.fields.length > 0) {
          await tx.formField.createMany({
            data: section.fields.map((f) => ({
              sectionId: newSection.id,
              cycleId: created.id,
              key: f.key,
              label: f.label,
              helpText: f.helpText,
              type: f.type,
              required: f.required,
              options: json(f.options),
              validation: json(f.validation),
              visibleWhen: json(f.visibleWhen),
              correctValue: f.correctValue,
              order: f.order,
            })),
          });
        }
      }

      if (source.cycleEmails.length > 0) {
        await tx.recruitmentCycleEmail.createMany({
          data: source.cycleEmails.map((e) => ({
            cycleId: created.id,
            key: e.key,
            subject: e.subject,
            body: e.body,
            updatedById: actorId,
          })),
        });
      }

      if (source.contract) {
        await tx.recruitmentCycleContract.create({
          data: { cycleId: created.id, layout: source.contract.layout as Prisma.InputJsonValue },
        });
      }

      if (source.scorers.length > 0) {
        await tx.cycleScorer.createMany({
          data: source.scorers.map((s) => ({ cycleId: created.id, personId: s.personId })),
        });
      }

      return created;
    },
    // A full director form is a few dozen sections; the default 5s interactive
    // timeout is tight for that many sequential inserts on a cold connection.
    { timeout: 30_000 },
  );

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.test_cycle_create",
    entityType: "RecruitmentCycle",
    entityId: copy.id,
    after: { sourceCycleId: source.id, title, publicSlug },
  });
  return copy;
}

/**
 * Delete a test run and everything made in it: applicants, applications,
 * scores, decisions, interviews, onboarding contracts and draft shifts all
 * cascade from the cycle. Refuses anything that is not a test run, so a real
 * cycle can never be deleted through here.
 */
export async function deleteTestCycle(id: string, actorId: string): Promise<{ sourceCycleId: string | null }> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new TestCycleError("Only recruitment leads can delete a test run.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id },
    select: { id: true, title: true, isTest: true, testSourceCycleId: true },
  });
  if (!cycle) throw new TestCycleError("Cycle not found.");
  if (!cycle.isTest) throw new TestCycleError("Only test runs can be deleted.");

  // Training references the cycle with Restrict, and a training row belongs to
  // a real person's standing for the term. A test run can never be the term's
  // training cycle, so there should be none; if one exists anyway, stop rather
  // than delete someone's training record along with the test.
  const trainings = await prisma.training.count({ where: { cycleId: id } });
  if (trainings > 0) {
    throw new TestCycleError("This test run has training records attached, so it can't be deleted. Ask IT to look at it.");
  }

  await prisma.recruitmentCycle.delete({ where: { id } });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.test_cycle_delete",
    entityType: "RecruitmentCycle",
    entityId: id,
    before: { title: cycle.title, sourceCycleId: cycle.testSourceCycleId },
  });
  return { sourceCycleId: cycle.testSourceCycleId };
}
