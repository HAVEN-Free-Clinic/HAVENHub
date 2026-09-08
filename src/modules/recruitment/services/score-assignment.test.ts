import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import {
  ScoreAssignmentError,
  loadScoringPanel,
  scorerQueueScope,
  setCycleScoring,
} from "./score-assignment";

let seq = 0;

async function personWith(name: string, permissions: string[]) {
  const person = await prisma.person.create({ data: { name, status: "ACTIVE" } });
  if (permissions.length > 0) {
    const role = await prisma.role.create({
      data: { name: `${name}-role-${seq++}`, grants: { create: permissions.map((permission) => ({ permission })) } },
    });
    await prisma.roleAssignment.create({ data: { personId: person.id, roleId: role.id } });
  }
  return person;
}

async function seed() {
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
  });
  const lead = await personWith("Lead", ["recruitment.review_all"]);
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "V",
      publicSlug: `v-assign-${seq++}`,
      departments: ["SRHD"],
      createdById: lead.id,
      status: "OPEN",
    },
  });
  const scorers = await Promise.all(
    ["Ann", "Bea", "Cal"].map((n) => personWith(n, ["recruitment.score"])),
  );
  return { term, lead, cycle, scorers };
}

/** One SUBMITTED application on a cycle, optionally authored by a Person. */
async function application(cycleId: string, tag: string, applicantPersonId?: string) {
  const applicant = await prisma.applicant.create({
    data: {
      cycleId,
      applicantPersonId: applicantPersonId ?? null,
      firstName: tag,
      lastName: "Applicant",
      email: `${tag}@yale.edu`,
      emailLower: `${tag}@yale.edu`,
    },
  });
  return prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      applicantType: "NEW",
      departmentChoices: ["SRHD"],
      answers: {},
      status: "SUBMITTED",
      submittedAt: new Date(),
    },
  });
}

const assignmentsFor = (cycleId: string) =>
  prisma.scoreAssignment.findMany({
    where: { application: { cycleId } },
    select: { applicationId: true, scorerId: true },
  });

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("setCycleScoring", () => {
  it("refuses a viewer without recruitment.review_all", async () => {
    const { cycle, scorers } = await seed();
    await expect(
      setCycleScoring(cycle.id, { scorerIds: [scorers[0].id], target: 2 }, scorers[0].id),
    ).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("saves the pool and the target, and divides the roster up", async () => {
    const { cycle, lead, scorers } = await seed();
    const apps = [await application(cycle.id, "a"), await application(cycle.id, "b")];

    const result = await setCycleScoring(
      cycle.id,
      { scorerIds: scorers.map((s) => s.id), target: 2 },
      lead.id,
    );

    expect(result.added).toBe(4);
    const saved = await prisma.recruitmentCycle.findUniqueOrThrow({
      where: { id: cycle.id },
      select: { scoresPerApplication: true },
    });
    expect(saved.scoresPerApplication).toBe(2);
    const rows = await assignmentsFor(cycle.id);
    expect(rows).toHaveLength(4);
    for (const app of apps) {
      expect(rows.filter((r) => r.applicationId === app.id)).toHaveLength(2);
    }
  });

  it("refuses to pool someone who does not hold recruitment.score", async () => {
    const { cycle, lead } = await seed();
    const bystander = await personWith("Bystander", []);
    await expect(
      setCycleScoring(cycle.id, { scorerIds: [bystander.id], target: 1 }, lead.id),
    ).rejects.toBeInstanceOf(ScoreAssignmentError);
  });

  it("rejects a target that is not a whole number in range", async () => {
    const { cycle, lead, scorers } = await seed();
    await expect(
      setCycleScoring(cycle.id, { scorerIds: [scorers[0].id], target: 0 }, lead.id),
    ).rejects.toBeInstanceOf(ScoreAssignmentError);
  });

  it("never hands a scorer their own application", async () => {
    const { cycle, lead, scorers } = await seed();
    const own = await application(cycle.id, "own", scorers[0].id);

    await setCycleScoring(cycle.id, { scorerIds: scorers.map((s) => s.id), target: 3 }, lead.id);

    const rows = await assignmentsFor(cycle.id);
    expect(rows.filter((r) => r.applicationId === own.id).map((r) => r.scorerId)).not.toContain(scorers[0].id);
    // Three in the pool, one of them the applicant, so two is all it can get.
    expect(rows.filter((r) => r.applicationId === own.id)).toHaveLength(2);
  });

  it("leaves applications that have left the committee alone", async () => {
    const { cycle, lead, scorers } = await seed();
    const open = await application(cycle.id, "open");
    const routed = await application(cycle.id, "routed");
    await prisma.application.update({ where: { id: routed.id }, data: { routedDepartmentCode: "SRHD" } });
    const decided = await application(cycle.id, "decided");
    await prisma.application.update({ where: { id: decided.id }, data: { decision: "REJECT" } });

    await setCycleScoring(cycle.id, { scorerIds: scorers.map((s) => s.id), target: 1 }, lead.id);

    const rows = await assignmentsFor(cycle.id);
    expect(rows.map((r) => r.applicationId)).toEqual([open.id]);
  });

  it("tops up a late application without disturbing the existing division", async () => {
    const { cycle, lead, scorers } = await seed();
    await application(cycle.id, "early");
    await setCycleScoring(cycle.id, { scorerIds: scorers.map((s) => s.id), target: 2 }, lead.id);
    const before = await assignmentsFor(cycle.id);

    const late = await application(cycle.id, "late");
    const result = await setCycleScoring(cycle.id, { scorerIds: scorers.map((s) => s.id), target: 2 }, lead.id);

    expect(result.added).toBe(2);
    const after = await assignmentsFor(cycle.id);
    expect(after.filter((r) => r.applicationId !== late.id)).toEqual(before);
  });

  it("moves a departed scorer's unscored work but keeps the score they gave", async () => {
    const { cycle, lead, scorers } = await seed();
    const [ann, bea, cal] = scorers;
    const scoredApp = await application(cycle.id, "scored");
    const openApp = await application(cycle.id, "open");
    await setCycleScoring(cycle.id, { scorerIds: [ann.id], target: 1 }, lead.id);
    await prisma.committeeScore.create({ data: { applicationId: scoredApp.id, scorerId: ann.id, score: 4 } });

    await setCycleScoring(cycle.id, { scorerIds: [bea.id, cal.id], target: 1 }, lead.id);

    const rows = await assignmentsFor(cycle.id);
    // Ann's score stands, so that application stays covered and her row survives.
    expect(rows).toContainEqual({ applicationId: scoredApp.id, scorerId: ann.id });
    // Her unscored one moved to the new pool.
    const moved = rows.filter((r) => r.applicationId === openApp.id);
    expect(moved).toHaveLength(1);
    expect(moved[0].scorerId).not.toBe(ann.id);
  });

  it("clears the division when the pool is emptied", async () => {
    const { cycle, lead, scorers } = await seed();
    await application(cycle.id, "a");
    await setCycleScoring(cycle.id, { scorerIds: [scorers[0].id], target: 1 }, lead.id);

    await setCycleScoring(cycle.id, { scorerIds: [], target: 1 }, lead.id);

    expect(await assignmentsFor(cycle.id)).toEqual([]);
    expect(await prisma.cycleScorer.count({ where: { cycleId: cycle.id } })).toBe(0);
  });
});

describe("scorerQueueScope", () => {
  it("reports a cycle with no pool as unpooled, so every scorer keeps the whole roster", async () => {
    const { cycle, scorers } = await seed();
    await application(cycle.id, "a");
    expect(await scorerQueueScope(cycle.id, scorers[0].id)).toEqual({ pooled: false, assignedIds: new Set() });
  });

  it("returns only this scorer's pile", async () => {
    const { cycle, lead, scorers } = await seed();
    await application(cycle.id, "a");
    await application(cycle.id, "b");
    await setCycleScoring(cycle.id, { scorerIds: scorers.map((s) => s.id), target: 1 }, lead.id);

    const mine = await scorerQueueScope(cycle.id, scorers[0].id);
    const theirs = await scorerQueueScope(cycle.id, scorers[1].id);

    expect(mine.pooled).toBe(true);
    for (const id of mine.assignedIds) expect(theirs.assignedIds.has(id)).toBe(false);
    expect(mine.assignedIds.size + theirs.assignedIds.size).toBeLessThanOrEqual(2);
  });
});

describe("loadScoringPanel", () => {
  it("lists every scorer with their load and flags what is still short", async () => {
    const { cycle, lead, scorers } = await seed();
    await application(cycle.id, "a");
    await application(cycle.id, "b");
    await setCycleScoring(cycle.id, { scorerIds: [scorers[0].id], target: 2 }, lead.id);
    await prisma.committeeScore.create({
      data: {
        applicationId: (await prisma.scoreAssignment.findFirstOrThrow()).applicationId,
        scorerId: scorers[0].id,
        score: 5,
      },
    });

    const panel = await loadScoringPanel(cycle.id, lead.id);

    expect(panel.target).toBe(2);
    expect(panel.eligibleCount).toBe(2);
    // A pool of one cannot reach a target of two, so both are short.
    expect(panel.underTargetCount).toBe(2);
    const ann = panel.candidates.find((c) => c.personId === scorers[0].id);
    expect(ann).toMatchObject({ inPool: true, assigned: 2, scored: 1 });
    expect(panel.candidates.find((c) => c.personId === scorers[1].id)).toMatchObject({ inPool: false, assigned: 0 });
  });

  it("refuses a viewer without recruitment.review_all", async () => {
    const { cycle, scorers } = await seed();
    await expect(loadScoringPanel(cycle.id, scorers[0].id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });
});
