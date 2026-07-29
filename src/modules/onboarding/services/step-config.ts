/**
 * Per-term onboarding step configuration.
 *
 * The six onboarding steps have built-in defaults (STEP_DEFAULTS). A term may
 * override any of them via a TermOnboardingStep row (toggle enabled, relabel,
 * change the description, flip blocking, reorder). A missing row means the
 * default, so an unconfigured term behaves exactly as before (no seed needed).
 */

import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import type { OnboardingTaskKey } from "../engine/status";

export type StepDefault = {
  label: string;
  description: string;
  order: number;
  blocking: boolean;
  href?: string;
  ctaLabel?: string;
  /** The step's page stays useful after completion, so the checklist offers a
   *  "Review" link once it is done. Only learning: the profile and HIPAA pages
   *  redirect away when their step is complete, so a link there would dead-end. */
  reviewable?: boolean;
  /** Copy shown while the step is IN_PROGRESS, when the generic description
   *  would misdescribe the state. Applied in buildTask AFTER term overrides
   *  resolve, because an override describes the step and this describes what
   *  the system is currently doing. Only hipaa needs it today. */
  inProgressDescription?: string;
  inProgressCtaLabel?: string;
};

/** Built-in defaults for each onboarding step (HAVEN voice; sentence case; no
 *  em-dashes). href/ctaLabel/reviewable are app-routing and are NOT
 *  term-configurable. */
export const STEP_DEFAULTS: Record<OnboardingTaskKey, StepDefault> = {
  profile: {
    label: "Profile & agreements",
    description: "Confirm your contact details so we can reach you about shifts.",
    order: 0,
    blocking: true,
    href: "/get-started/profile",
    ctaLabel: "Complete profile",
  },
  hipaa: {
    label: "HIPAA certificate",
    description: "Upload your current HIPAA certificate so we can verify it is valid through the term.",
    order: 1,
    blocking: true,
    href: "/get-started/hipaa",
    ctaLabel: "Upload certificate",
    inProgressDescription: "We have your certificate. A compliance manager is confirming the date.",
    inProgressCtaLabel: "View certificate",
  },
  training: {
    label: "Volunteer training",
    description: "Finish this term's training to be cleared for shifts.",
    order: 2,
    blocking: true,
    href: "/get-started/training?track=volunteer",
    ctaLabel: "Go to training",
  },
  directorTraining: {
    label: "Director training",
    description: "Finish this term's director training to be cleared for shifts.",
    order: 3,
    blocking: true,
    href: "/get-started/training?track=director",
    ctaLabel: "Go to training",
  },
  learning: {
    label: "Learning modules",
    description: "Complete the courses your department assigned to you.",
    order: 4,
    blocking: true,
    href: "/get-started/learning",
    ctaLabel: "Open courses",
    reviewable: true,
  },
  ehs: {
    label: "EHS training",
    description: "Environmental Health and Safety trainings are recorded by your coordinator once you complete them in Yale's EHS system.",
    order: 5,
    blocking: false,
  },
};

export const ONBOARDING_STEP_KINDS = Object.keys(STEP_DEFAULTS) as OnboardingTaskKey[];

export type EffectiveStep = {
  kind: OnboardingTaskKey;
  enabled: boolean;
  label: string;
  description: string;
  blocking: boolean;
  order: number;
  href?: string;
  ctaLabel?: string;
  reviewable?: boolean;
  inProgressDescription?: string;
  inProgressCtaLabel?: string;
  /** True when a per-term override row exists for this kind. */
  hasOverride: boolean;
};

type OverrideRow = {
  enabled: boolean;
  label: string | null;
  description: string | null;
  blocking: boolean | null;
  order: number;
};

function effective(kind: OnboardingTaskKey, row: OverrideRow | undefined): EffectiveStep {
  const d = STEP_DEFAULTS[kind];
  return {
    kind,
    enabled: row?.enabled ?? true,
    label: row?.label ?? d.label,
    description: row?.description ?? d.description,
    blocking: row?.blocking ?? d.blocking,
    order: row?.order ?? d.order,
    href: d.href,
    ctaLabel: d.ctaLabel,
    reviewable: d.reviewable,
    inProgressDescription: d.inProgressDescription,
    inProgressCtaLabel: d.inProgressCtaLabel,
    hasOverride: row !== undefined,
  };
}

/** Effective onboarding steps for a term (defaults merged with overrides), keyed
 *  by kind. Every kind is present. Consumed by getOnboardingStatus. */
export async function loadEffectiveSteps(
  termId: string,
): Promise<Map<OnboardingTaskKey, EffectiveStep>> {
  const rows = await prisma.termOnboardingStep.findMany({ where: { termId } });
  const byKind = new Map(rows.map((r) => [r.kind, r as OverrideRow]));
  const out = new Map<OnboardingTaskKey, EffectiveStep>();
  for (const kind of ONBOARDING_STEP_KINDS) {
    out.set(kind, effective(kind, byKind.get(kind)));
  }
  return out;
}

/** The six steps for the admin editor, sorted by effective order. */
export async function listStepConfig(termId: string): Promise<EffectiveStep[]> {
  const map = await loadEffectiveSteps(termId);
  return [...map.values()].sort((a, b) => a.order - b.order);
}

export class StepConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepConfigError";
  }
}

export type StepConfigPatch = {
  enabled?: boolean;
  /** null clears the override (falls back to the default label). */
  label?: string | null;
  description?: string | null;
  /** null clears the blocking override (falls back to the default). */
  blocking?: boolean | null;
  order?: number;
};

/** Upsert a per-term override for one step kind. Requires admin.manage_terms.
 *  Undefined patch fields are left unchanged; null clears an override to default. */
export async function setStepConfig(
  actorId: string,
  termId: string,
  kind: OnboardingTaskKey,
  patch: StepConfigPatch,
): Promise<void> {
  if (!(await can(actorId, "admin.manage_terms"))) {
    throw new StepConfigError("Only term managers can edit onboarding steps.");
  }
  if (!ONBOARDING_STEP_KINDS.includes(kind)) {
    throw new StepConfigError(`Unknown onboarding step: ${kind}`);
  }
  const d = STEP_DEFAULTS[kind];
  await prisma.termOnboardingStep.upsert({
    where: { termId_kind: { termId, kind } },
    create: {
      termId,
      kind,
      enabled: patch.enabled ?? true,
      label: patch.label ?? null,
      description: patch.description ?? null,
      blocking: patch.blocking ?? null,
      order: patch.order ?? d.order,
    },
    update: {
      enabled: patch.enabled,
      label: patch.label,
      description: patch.description,
      blocking: patch.blocking,
      order: patch.order,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "admin.onboarding_step_config",
    entityType: "TermOnboardingStep",
    entityId: `${termId}:${kind}`,
    after: {
      enabled: patch.enabled ?? null,
      label: patch.label ?? null,
      blocking: patch.blocking ?? null,
      order: patch.order ?? null,
    },
  });
}
