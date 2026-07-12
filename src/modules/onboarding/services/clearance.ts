import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { complianceStatus } from "@/platform/compliance/rules";
import { loadEhsItemsMap } from "@/platform/ehs/services/status";
import {
  coursesForMember,
  type AssignableCourse,
  type MemberMembership,
} from "@/modules/learning/engine/assignment";
import { deriveStatus } from "@/modules/learning/engine/status";
import {
  deriveProfileTaskState,
  deriveHipaaTaskState,
  deriveLearningTaskState,
  deriveEhsTaskState,
  computeGating,
  isSatisfied,
  type OnboardingTaskKey,
  type OnboardingTaskState,
} from "../engine/status";

export type ClearanceTask = { key: OnboardingTaskKey; state: OnboardingTaskState; blocking: boolean };
export type ClearanceSummary = {
  onboarded: boolean;
  cleared: boolean;
  tasks: ClearanceTask[];
  /** Task keys not satisfied (i.e. neither COMPLETE nor NOT_REQUIRED). */
  missing: OnboardingTaskKey[];
};

/**
 * Batched clearance for many people in one term. Reuses the exact pure engine that
 * getOnboardingStatus uses, over bulk-loaded inputs, so it agrees with the single-person
 * path on the onboarded/cleared gates. Training here is COMPLETE-or-INCOMPLETE only (the
 * IN_PROGRESS nuance the checklist shows is irrelevant to gating), which is why it does not
 * count quiz attempts. Every input personId is present in the result.
 *
 * `now` (optional) is the reference time for HIPAA cert expiry; it defaults to the
 * current time. Callers that evaluate clearance "as of" a specific moment (e.g. the
 * schedule builder passing a test/clinic reference time) thread it through here.
 */
export async function loadClearanceMap(
  personIds: string[],
  termId: string,
  now?: Date
): Promise<Map<string, ClearanceSummary>> {
  const out = new Map<string, ClearanceSummary>();
  if (personIds.length === 0) return out;

  const term = await prisma.term.findUnique({ where: { id: termId }, select: { endDate: true } });
  const termEnd = term?.endDate ?? null;

  const [persons, memberships, certRows, trainingRows, designatedCycles, activeCourses, ehsItemsMap] =
    await Promise.all([
      prisma.person.findMany({
        where: { id: { in: personIds } },
        select: { id: true, contactEmail: true, phone: true },
      }),
      prisma.termMembership.findMany({
        where: { personId: { in: personIds }, termId, status: "ACTIVE" },
        select: { personId: true, kind: true, departmentId: true },
      }),
      prisma.hipaaCertificate.findMany({
        where: { personId: { in: personIds } },
        orderBy: { uploadedAt: "desc" },
        select: { personId: true, completionDate: true, verifiedAt: true },
      }),
      prisma.training.findMany({
        where: { personId: { in: personIds }, termId, status: "COMPLETE" },
        select: { personId: true, track: true },
      }),
      prisma.recruitmentCycle.findMany({
        where: { termId, isTermTraining: true },
        select: { track: true },
      }),
      prisma.course.findMany({
        where: { isActive: true },
        select: {
          id: true,
          isActive: true,
          assignToAll: true,
          audience: true,
          scormEntryHref: true,
          departments: { select: { departmentId: true } },
        },
      }),
      loadEhsItemsMap(termId),
    ]);

  // Newest cert per person (rows are uploadedAt desc; first seen wins).
  const certByPerson = new Map<string, { completionDate: Date | null; verifiedAt: Date | null }>();
  for (const c of certRows) {
    if (!certByPerson.has(c.personId)) {
      certByPerson.set(c.personId, { completionDate: c.completionDate, verifiedAt: c.verifiedAt });
    }
  }

  const membershipsByPerson = new Map<string, MemberMembership[]>();
  const kindsByPerson = new Map<string, Set<Track>>();
  for (const m of memberships) {
    if (!membershipsByPerson.has(m.personId)) {
      membershipsByPerson.set(m.personId, []);
      kindsByPerson.set(m.personId, new Set());
    }
    membershipsByPerson.get(m.personId)!.push({ departmentId: m.departmentId, kind: m.kind });
    kindsByPerson.get(m.personId)!.add(m.kind);
  }

  const completeTrack = new Set(trainingRows.map((t) => `${t.personId}:${t.track}`));
  const designatedTracks = new Set(designatedCycles.map((c) => c.track));

  const assignable: AssignableCourse[] = activeCourses.map((c) => ({
    id: c.id,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    departmentIds: c.departments.map((d) => d.departmentId),
    hasPackage: c.scormEntryHref != null,
    audience: c.audience,
  }));
  const activeCourseIds = assignable.map((c) => c.id);
  const progressRows = activeCourseIds.length
    ? await prisma.courseProgress.findMany({
        where: { personId: { in: personIds }, courseId: { in: activeCourseIds } },
        select: { personId: true, courseId: true, lessonStatus: true },
      })
    : [];
  const progressByPerson = new Map<string, Map<string, string | null>>();
  for (const p of progressRows) {
    if (!progressByPerson.has(p.personId)) progressByPerson.set(p.personId, new Map());
    progressByPerson.get(p.personId)!.set(p.courseId, p.lessonStatus);
  }

  const profileByPerson = new Map(persons.map((p) => [p.id, p]));

  for (const personId of personIds) {
    const profile = profileByPerson.get(personId) ?? { contactEmail: null, phone: null };
    const cert = certByPerson.get(personId) ?? null;
    const personMemberships = membershipsByPerson.get(personId) ?? [];
    const kinds = kindsByPerson.get(personId) ?? new Set<Track>();

    const trainingTasks: ClearanceTask[] = [];
    for (const track of ["VOLUNTEER", "DIRECTOR"] as Track[]) {
      const required = kinds.has(track) && designatedTracks.has(track);
      if (!required) continue;
      const state: OnboardingTaskState = completeTrack.has(`${personId}:${track}`)
        ? "COMPLETE"
        : "INCOMPLETE";
      trainingTasks.push({
        key: track === "DIRECTOR" ? "directorTraining" : "training",
        state,
        blocking: true,
      });
    }

    const assignedIds = coursesForMember({ courses: assignable, memberships: personMemberships });
    const personProgress = progressByPerson.get(personId);
    const learningCourses = assignedIds.map((id) => {
      const ls = personProgress?.get(id);
      const status = ls == null ? ("NOT_STARTED" as const) : deriveStatus(ls).status;
      return { status };
    });

    const ehsItems = ehsItemsMap.get(personId) ?? [];

    const tasks: ClearanceTask[] = [
      { key: "profile", state: deriveProfileTaskState(profile), blocking: true },
      { key: "hipaa", state: deriveHipaaTaskState(complianceStatus(cert, termEnd, now)), blocking: true },
      ...trainingTasks,
      { key: "learning", state: deriveLearningTaskState(learningCourses), blocking: true },
      { key: "ehs", state: deriveEhsTaskState(ehsItems), blocking: false },
    ];

    const { onboarded, cleared } = computeGating(tasks);
    const missing = tasks.filter((t) => !isSatisfied(t.state)).map((t) => t.key);
    out.set(personId, { onboarded, cleared, tasks, missing });
  }

  return out;
}
