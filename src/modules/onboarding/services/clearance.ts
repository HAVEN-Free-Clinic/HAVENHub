import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { effectiveComplianceStatus } from "@/platform/compliance/rules";
import { loadEhsItemsMap } from "@/platform/ehs/services/status";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  coursesForMember,
  coursesSatisfiableInTerm,
  splitByRecurrence,
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
import { loadEffectiveSteps } from "./step-config";

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

  // Per-term step config: the single-person getOnboardingStatus drops disabled
  // steps and honors a term's blocking override via loadEffectiveSteps/buildTask.
  // Load it here too so the batch onboarded/cleared gates agree with that path.
  const steps = await loadEffectiveSteps(termId);
  const [activeTerm, persons, memberships, certRows, trainingRows, designatedCycles, activeCourses, ehsItemsMap] =
    await Promise.all([
      // Which term learning writes land in; see coursesSatisfiableInTerm below.
      // cache()d per request, so this is free on a page that already resolved it.
      getActiveTerm(),
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
          recurrence: true,
          departments: { select: { departmentId: true } },
        },
      }),
      loadEhsItemsMap(termId),
    ]);

  // All certs per person, newest first (rows are uploadedAt desc), so an early
  // renewal (an unverified newest cert) can fall back to a still-valid verified
  // cert instead of un-clearing the volunteer while the upload awaits verification.
  const certsByPerson = new Map<string, { completionDate: Date | null; verifiedAt: Date | null }[]>();
  for (const c of certRows) {
    const list = certsByPerson.get(c.personId) ?? [];
    list.push({ completionDate: c.completionDate, verifiedAt: c.verifiedAt });
    certsByPerson.set(c.personId, list);
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

  // Drop PER_TERM courses when this map is answering for a term that is not the
  // ACTIVE one. Their progress rows are written against the active term and read
  // against `termId`, so for a next (PLANNING) term the requirement is unclearable
  // and every member read as permanently "not cleared" on the schedule builder's
  // banner and in the Epic roll-up. getMyCourses applies the identical rule, which
  // is what keeps this map and a member's own checklist agreeing (audit 14, L1).
  const satisfiableCourses = coursesSatisfiableInTerm(activeCourses, activeTerm?.id === termId);

  const assignable: AssignableCourse[] = satisfiableCourses.map((c) => ({
    id: c.id,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    departmentIds: c.departments.map((d) => d.departmentId),
    hasPackage: c.scormEntryHref != null,
    audience: c.audience,
  }));
  const activeCourseIds = assignable.map((c) => c.id);

  // Scope the progress lookup by term for PER_TERM courses only, exactly like
  // getMyCourses; ONCE stays unscoped (today's behavior, unchanged). This must not
  // diverge from getMyCourses/getOnboardingStatus: this map feeds the schedule
  // builder's clearance banner, and the whole reason learning carries a termId at
  // all is so that banner and a member's own checklist agree for a given term.
  const { onceIds, perTermIds } = splitByRecurrence(satisfiableCourses);
  const progressRows = activeCourseIds.length
    ? await prisma.courseProgress.findMany({
        where: {
          personId: { in: personIds },
          OR: [
            ...(onceIds.length ? [{ courseId: { in: onceIds } }] : []),
            ...(perTermIds.length ? [{ courseId: { in: perTermIds }, termId }] : []),
          ],
        },
        select: { personId: true, courseId: true, lessonStatus: true },
        // ONCE courses are read UNSCOPED, so one (person, course) can match more
        // than one row: a course toggled to PER_TERM, run for a term or two, then
        // toggled back leaves a row per term behind. The map below is last-wins,
        // and without an order Postgres may hand back the stale incomplete row
        // last -- so the builder's banner called a member not cleared while their
        // own checklist (getMyCourses, which has always ordered here) said
        // Complete. Completed rows sort last and therefore win; id breaks the
        // remaining ties totally, because a createdAt tie is a known flake source
        // in this repo and leaves the same non-determinism in place (audit 14, L4).
        orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      })
    : [];
  const progressByPerson = new Map<string, Map<string, string | null>>();
  for (const p of progressRows) {
    if (!progressByPerson.has(p.personId)) progressByPerson.set(p.personId, new Map());
    progressByPerson.get(p.personId)!.set(p.courseId, p.lessonStatus);
  }

  const profileByPerson = new Map(persons.map((p) => [p.id, p]));

  // Apply the term's step config to a candidate task: a disabled step is dropped
  // (returns null) and the (possibly term-overridden) blocking flag replaces the
  // default. Mirrors buildTask in getOnboardingStatus so the two paths agree.
  const applyStep = (key: OnboardingTaskKey, state: OnboardingTaskState): ClearanceTask | null => {
    const s = steps.get(key);
    if (!s || !s.enabled) return null;
    return { key, state, blocking: s.blocking };
  };

  for (const personId of personIds) {
    const profile = profileByPerson.get(personId) ?? { contactEmail: null, phone: null };
    const certs = certsByPerson.get(personId) ?? [];
    const personMemberships = membershipsByPerson.get(personId) ?? [];
    const kinds = kindsByPerson.get(personId) ?? new Set<Track>();

    const trainingTasks: ClearanceTask[] = [];
    for (const track of ["VOLUNTEER", "DIRECTOR"] as Track[]) {
      const required = kinds.has(track) && designatedTracks.has(track);
      if (!required) continue;
      const state: OnboardingTaskState = completeTrack.has(`${personId}:${track}`)
        ? "COMPLETE"
        : "INCOMPLETE";
      const t = applyStep(track === "DIRECTOR" ? "directorTraining" : "training", state);
      if (t) trainingTasks.push(t);
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
      applyStep("profile", deriveProfileTaskState(profile)),
      applyStep("hipaa", deriveHipaaTaskState(effectiveComplianceStatus(certs, termEnd, now))),
      ...trainingTasks,
      applyStep("learning", deriveLearningTaskState(learningCourses)),
      applyStep("ehs", deriveEhsTaskState(ehsItems)),
    ].filter((t): t is ClearanceTask => t !== null);

    const { onboarded, cleared } = computeGating(tasks);
    const missing = tasks.filter((t) => !isSatisfied(t.state)).map((t) => t.key);
    out.set(personId, { onboarded, cleared, tasks, missing });
  }

  return out;
}
