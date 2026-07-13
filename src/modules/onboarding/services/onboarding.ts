import { cache } from "react";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { complianceStatus } from "@/platform/compliance/rules";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { requiredTrainingTracks, resolveTrainingProgress } from "@/modules/recruitment/services/training";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { getMyEhsStatus } from "@/platform/ehs/services/my-ehs";
import {
  deriveProfileTaskState,
  deriveHipaaTaskState,
  deriveTrainingTaskState,
  deriveLearningTaskState,
  deriveEhsTaskState,
  computeGating,
  summarize,
  type OnboardingTaskKey,
  type OnboardingTaskState,
} from "../engine/status";
import { loadEffectiveSteps } from "./step-config";

/** The permission that exempts a person from the gate (IT / super-admin proxy). */
export const EXEMPT_PERMISSION = "admin.access";

export type OnboardingTask = {
  key: OnboardingTaskKey;
  label: string;
  description: string;
  // Actionable tasks link to an allowlisted /get-started fix-it page. Tasks the
  // volunteer cannot self-serve (EHS is recorded by a coordinator) omit these so
  // the checklist shows status only, with no CTA that dead-ends at the gate.
  href?: string;
  ctaLabel?: string;
  state: OnboardingTaskState;
  blocking: boolean;
};

export type OnboardingStatus = {
  hasActiveTerm: boolean;
  exempt: boolean;
  tasks: OnboardingTask[];
  completedCount: number;
  totalCount: number;
  onboarded: boolean;
  cleared: boolean;
};

type Entry = { task: OnboardingTask; order: number };

/**
 * Compute a person's onboarding clearance for the active term. Returns a dormant
 * (onboarded:true, cleared:true) status when there is no active term, so the gate never blocks.
 *
 * The step list, labels, descriptions, blocking flags, and order come from the
 * term's effective onboarding-step config (built-in defaults merged with any
 * per-term overrides). A step whose config is disabled is dropped entirely.
 */
export const getOnboardingStatus = cache(async function getOnboardingStatus(
  personId: string
): Promise<OnboardingStatus> {
  const exempt = await can(personId, EXEMPT_PERMISSION);

  const term = await getActiveTerm();
  if (!term) {
    return { hasActiveTerm: false, exempt, tasks: [], completedCount: 0, totalCount: 0, onboarded: true, cleared: true };
  }

  const [person, certs, courses, tracks, ehsItems, steps] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { contactEmail: true, phone: true } }),
    listMyCertificates(personId),
    getMyCourses(personId),
    requiredTrainingTracks(personId, term.id),
    getMyEhsStatus(personId),
    loadEffectiveSteps(term.id),
  ]);

  // Build one entry per applicable, enabled step, carrying its (possibly
  // term-overridden) label/description/blocking/order. A disabled step is dropped.
  function buildTask(key: OnboardingTaskKey, state: OnboardingTaskState): Entry | null {
    const s = steps.get(key);
    if (!s || !s.enabled) return null;
    return {
      task: {
        key,
        state,
        blocking: s.blocking,
        label: s.label,
        description: s.description,
        href: s.href,
        ctaLabel: s.ctaLabel,
      },
      order: s.order,
    };
  }

  const trainingEntries: Entry[] = [];
  for (const track of tracks) {
    // attemptsUsed lets the checklist render IN_PROGRESS for a started-but-unpassed
    // quiz; the gate itself still only clears on a COMPLETE state.
    const { state, attemptsUsed } = await resolveTrainingProgress(personId, term.id, track);
    const key = track === "DIRECTOR" ? "directorTraining" : "training";
    const entry = buildTask(key, deriveTrainingTaskState({ state, attemptsUsed }));
    if (entry) trainingEntries.push(entry);
  }

  const entries = [
    buildTask("profile", deriveProfileTaskState(person)),
    buildTask("hipaa", deriveHipaaTaskState(complianceStatus(certs[0] ?? null, term.endDate))),
    ...trainingEntries,
    buildTask("learning", deriveLearningTaskState(courses)),
    buildTask("ehs", deriveEhsTaskState(ehsItems)),
  ].filter((e): e is Entry => e !== null);

  entries.sort((a, b) => a.order - b.order);
  const tasks = entries.map((e) => e.task);

  const { completedCount, totalCount } = summarize(tasks.map((t) => t.state));
  const { onboarded, cleared } = computeGating(tasks);
  return { hasActiveTerm: true, exempt, tasks, completedCount, totalCount, onboarded, cleared };
});
