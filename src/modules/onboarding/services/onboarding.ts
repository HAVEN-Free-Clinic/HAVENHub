import { cache } from "react";
import type { Term } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getPersonTerms } from "@/platform/terms/person-terms";
import { effectiveComplianceStatus } from "@/platform/compliance/rules";
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
  // Actionable tasks link to an allowlisted /get-started fix-it page. Tasks with
  // no in-app fix-it page omit these (EHS is recorded by a coordinator); the
  // checklist row may still render an external CTA (EHS links out to Workday).
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
 * Compute a person's onboarding clearance for one specific term.
 *
 * The step list, labels, descriptions, blocking flags, and order come from the
 * term's effective onboarding-step config (built-in defaults merged with any
 * per-term overrides). A step whose config is disabled is dropped entirely.
 *
 * Every task, including `learning` (getMyCourses) and `ehs` (getMyEhsStatus), is
 * computed for the passed `term`. Those two used to resolve the active term
 * internally and were therefore omitted for a non-live term, which left this
 * member-facing checklist out of step with the schedule builder's "not cleared"
 * banner (loadClearanceMap), which has always computed them for the working
 * term. They now accept the term id, so the two agree for a next term. The
 * live-vs-next presentation is the caller's concern (by term order); this
 * function does not distinguish.
 */
export async function computeOnboardingForTerm(
  personId: string,
  term: Term,
  exempt: boolean,
): Promise<OnboardingStatus> {
  const [person, certs, tracks, steps, courses, ehsItems] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { contactEmail: true, phone: true } }),
    listMyCertificates(personId),
    requiredTrainingTracks(personId, term.id),
    loadEffectiveSteps(term.id),
    getMyCourses(personId, term.id),
    getMyEhsStatus(personId, term.id),
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
    // Use the full cert history with the verified-fallback (not just the newest cert):
    // an early renewal awaiting verification must not revoke clearance a still-valid
    // verified cert already grants. Mirrors loadClearanceMap so the gate and the roster
    // agree. See effectiveComplianceStatus.
    buildTask("hipaa", deriveHipaaTaskState(effectiveComplianceStatus(certs, term.endDate))),
    ...trainingEntries,
    // learning/ehs are now computed for `term` (see doc comment above), so they
    // are included for every term the member is on, live or next.
    buildTask("learning", deriveLearningTaskState(courses)),
    buildTask("ehs", deriveEhsTaskState(ehsItems)),
  ].filter((e): e is Entry => e !== null);

  entries.sort((a, b) => a.order - b.order);
  const tasks = entries.map((e) => e.task);

  const { completedCount, totalCount } = summarize(tasks.map((t) => t.state));
  const { onboarded, cleared } = computeGating(tasks);
  return { hasActiveTerm: true, exempt, tasks, completedCount, totalCount, onboarded, cleared };
}

/**
 * The live-term onboarding gate. Returns a dormant (onboarded:true, cleared:true)
 * status when there is no live term, so the gate never blocks. This drives
 * enforceOnboarding and any hard clearance decision. Next-term work is
 * intentionally excluded here; see getMyOnboarding for the merged, multi-term
 * display.
 */
export const getOnboardingStatus = cache(async function getOnboardingStatus(
  personId: string
): Promise<OnboardingStatus> {
  const exempt = await can(personId, EXEMPT_PERMISSION);

  const term = await getActiveTerm();
  if (!term) {
    return { hasActiveTerm: false, exempt, tasks: [], completedCount: 0, totalCount: 0, onboarded: true, cleared: true };
  }

  return computeOnboardingForTerm(personId, term, exempt);
});

export type TermOnboarding = { term: { id: string; name: string; endDate: Date }; status: OnboardingStatus };

/** The merged onboarding checklist across every term the member belongs to (live first). */
export const getMyOnboarding = cache(async function getMyOnboarding(personId: string): Promise<TermOnboarding[]> {
  const exempt = await can(personId, EXEMPT_PERMISSION);
  // getPersonTerms already returns the working set live-term first, so the caller
  // can tag presentation from order; the status is computed the same way per term.
  const terms = await getPersonTerms(personId);
  const out: TermOnboarding[] = [];
  for (const term of terms) {
    const status = await computeOnboardingForTerm(personId, term, exempt);
    // endDate is returned so the dashboard can compute HIPAA/compliance copy PER
    // term: COMPLIANT requires expiresAt >= termEnd + 30d, so a cert that clears the
    // live term but not a next term must read "Renew before ..." under that term (#87).
    out.push({ term: { id: term.id, name: term.name, endDate: term.endDate }, status });
  }
  return out;
});
