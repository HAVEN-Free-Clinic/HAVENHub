import { randomBytes } from "node:crypto";
import type { Prisma, RecruitmentCycle } from "@prisma/client";
import { prisma, type TransactionClient } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";

/**
 * Test runs: a throwaway copy of a cycle that recruitment walks through with
 * made-up applicants before the real one goes out.
 *
 * WHAT FOLLOWS THE REAL CYCLE. Everything that decides what an applicant sees
 * follows the real cycle and updates the moment it changes there: the
 * application form (sections and fields), the per-cycle email overrides, the
 * onboarding contract layout, the departments, whether renewals are accepted,
 * the training and quiz settings, and the title. Every service that edits one
 * of those calls syncTestRunsOf(cycleId) after it writes, and refuses the edit
 * outright on a test run (testRunLockMessage), so a test run can never drift
 * from the cycle it rehearses. Global email templates and the global contract
 * template are not copied at all: both cycles resolve them at send time, so
 * they follow automatically.
 *
 * WHAT IS THE TEST RUN'S OWN. Everything about running it: its status and
 * application window, its applicants and everything done with them, and its
 * scoring setup (scorers, scores per application) and routing thresholds,
 * which start from the real cycle's values and can then be changed in the
 * test run without touching the real one. The scorer pool is NOT copied:
 * copying it would put real committee members' names on fake applications
 * and in their scoring queues, so a test run starts with no scorers and the
 * tester adds whoever is rehearsing.
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
 *     (liveAcceptanceWhere), and promotion refuses it, so nobody reaches the roster;
 *   - email campaign audiences, term-transition renewal checks, specialty-clinic
 *     interest and the applicant history page all leave its applications out.
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

/** What a sync reads off the real cycle: exactly the parts a test run follows. */
const followedInclude = {
  // Read raw, not through loadCycle: that resolves availability options against
  // the clinic calendar for display, and the copy must store what the source
  // stored, not a rendering of it.
  sections: { include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
  cycleEmails: true,
  contract: true,
} satisfies Prisma.RecruitmentCycleInclude;

type FollowedSource = Prisma.RecruitmentCycleGetPayload<{ include: typeof followedInclude }>;

/**
 * Make `targetId` match `source` in everything a test run follows. Replaces the
 * target's form, email overrides and contract wholesale rather than diffing:
 * applicants' answers are stored by field key (never by field or section id),
 * so rebuilding the form under someone halfway through an application loses
 * nothing they typed, and a wholesale replace has no ordering or rename cases
 * to get wrong.
 */
async function applyFollowedConfig(tx: TransactionClient, source: FollowedSource, targetId: string): Promise<void> {
  // Sections cascade their fields.
  await tx.formSection.deleteMany({ where: { cycleId: targetId } });
  for (const section of source.sections) {
    const newSection = await tx.formSection.create({
      data: {
        cycleId: targetId,
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
          cycleId: targetId,
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

  await tx.recruitmentCycleEmail.deleteMany({ where: { cycleId: targetId } });
  if (source.cycleEmails.length > 0) {
    await tx.recruitmentCycleEmail.createMany({
      data: source.cycleEmails.map((e) => ({
        cycleId: targetId,
        key: e.key,
        subject: e.subject,
        body: e.body,
        updatedById: e.updatedById,
      })),
    });
  }

  await tx.recruitmentCycleContract.deleteMany({ where: { cycleId: targetId } });
  if (source.contract) {
    await tx.recruitmentCycleContract.create({
      data: { cycleId: targetId, layout: source.contract.layout as Prisma.InputJsonValue },
    });
  }

  await tx.recruitmentCycle.update({
    where: { id: targetId },
    data: {
      title: `${TEST_TITLE_PREFIX}${source.title}`,
      departments: source.departments,
      acceptsRenewals: source.acceptsRenewals,
      quizPassPercent: source.quizPassPercent,
      quizMaxAttempts: source.quizMaxAttempts,
      trainingLocation: source.trainingLocation,
      inPersonTrainingDate: source.inPersonTrainingDate,
      testSyncedAt: new Date(),
    },
  });
}

/** Re-apply the real cycle's followed config to one test run, inside one
 *  transaction. The test run's row is locked first and the real cycle is read
 *  only after the lock is held, so two edits saved back to back can never
 *  finish out of order and leave the test run on the older version. */
async function syncOne(testRunId: string, sourceId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "RecruitmentCycle" WHERE "id" = ${testRunId} FOR UPDATE`;
      const source = await tx.recruitmentCycle.findUnique({ where: { id: sourceId }, include: followedInclude });
      // The real cycle is gone: nothing to follow, and the test run keeps the
      // last version it had. Its page says so.
      if (!source) return;
      await applyFollowedConfig(tx, source, testRunId);
    },
    // A full director form is a few dozen sections; the default 5s interactive
    // timeout is tight for that many sequential inserts on a cold connection.
    { timeout: 30_000 },
  );
}

/**
 * Bring every test run of `cycleId` up to date with it. Called by every service
 * that edits something a test run follows, right after its write, which is
 * what makes a change to the real cycle show in its test runs immediately.
 *
 * Never throws. The real cycle's edit has already been saved by the time this
 * runs, and failing the person's save because a rehearsal copy could not be
 * refreshed would tell them their real edit failed when it did not. A failed
 * sync is logged, and the test run's page has an "Update from the real cycle"
 * button that runs the same sync by hand.
 */
export async function syncTestRunsOf(cycleId: string): Promise<void> {
  try {
    const runs = await prisma.recruitmentCycle.findMany({
      where: { testSourceCycleId: cycleId, isTest: true },
      select: { id: true },
    });
    for (const run of runs) await syncOne(run.id, cycleId);
  } catch (err) {
    // cycleId goes in as an argument, not part of the message, so a % in it
    // can never be read as a format directive.
    console.error("[test-cycles] could not update the test runs of cycle %s", cycleId, err);
  }
}

/**
 * Null when `cycleId` may have its form, emails, contract or followed settings
 * edited; otherwise the sentence to show. Each editing service throws its own
 * domain error with this message, so the page that called it already knows how
 * to show it.
 */
export async function testRunLockMessage(cycleId: string): Promise<string | null> {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { isTest: true, testSourceCycleId: true },
  });
  if (!cycle?.isTest) return null;
  const source = cycle.testSourceCycleId
    ? await prisma.recruitmentCycle.findUnique({ where: { id: cycle.testSourceCycleId }, select: { title: true } })
    : null;
  return source
    ? `This is a test run, so it follows "${source.title}". Make this change there and it shows up here right away.`
    : "This is a test run, and the cycle it followed has been deleted, so it can no longer be edited.";
}

export async function createTestCycle(sourceId: string, actorId: string): Promise<RecruitmentCycle> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new TestCycleError("Only recruitment leads can start a test run.");
  }
  const source = await prisma.recruitmentCycle.findUnique({ where: { id: sourceId }, include: followedInclude });
  if (!source) throw new TestCycleError("Cycle not found.");
  if (source.isTest) throw new TestCycleError("This is already a test run. Start a new one from the real cycle.");

  const publicSlug = `${source.publicSlug}-test-${slugSuffix()}`;

  const copy = await prisma.$transaction(
    async (tx) => {
      const created = await tx.recruitmentCycle.create({
        data: {
          track: source.track,
          termId: source.termId,
          title: `${TEST_TITLE_PREFIX}${source.title}`,
          publicSlug,
          // The test run's own settings, started from the real cycle's values.
          routeTopPercent: source.routeTopPercent,
          routeBottomPercent: source.routeBottomPercent,
          scoresPerApplication: source.scoresPerApplication,
          isTest: true,
          testSourceCycleId: source.id,
          createdById: actorId,
          // Left at their defaults on purpose: status DRAFT, no application
          // window, isTermTraining false, nothing released, no scorers.
        },
      });
      await applyFollowedConfig(tx, source, created.id);
      return tx.recruitmentCycle.findUniqueOrThrow({ where: { id: created.id } });
    },
    { timeout: 30_000 },
  );

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.test_cycle_create",
    entityType: "RecruitmentCycle",
    entityId: copy.id,
    after: { sourceCycleId: source.id, title: copy.title, publicSlug },
  });
  return copy;
}

/** The "Update from the real cycle" button: the same sync an edit runs, by
 *  hand, for when an automatic one failed. Unlike syncTestRunsOf this throws,
 *  because here the person asked for exactly this and should see why not. */
export async function resyncTestCycle(id: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new TestCycleError("Only recruitment leads can update a test run.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id },
    select: { isTest: true, testSourceCycleId: true },
  });
  if (!cycle) throw new TestCycleError("Cycle not found.");
  if (!cycle.isTest) throw new TestCycleError("Only a test run can be updated from another cycle.");
  if (!cycle.testSourceCycleId) throw new TestCycleError("The cycle this test run followed has been deleted.");
  const source = await prisma.recruitmentCycle.findUnique({ where: { id: cycle.testSourceCycleId }, select: { id: true } });
  if (!source) throw new TestCycleError("The cycle this test run followed has been deleted.");
  await syncOne(id, source.id);
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
