import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { complianceStatus } from "@/platform/compliance/rules";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import {
  deriveProfileTaskState,
  deriveHipaaTaskState,
  deriveTrainingTaskState,
  deriveLearningTaskState,
  summarize,
  type OnboardingTaskKey,
  type OnboardingTaskState,
} from "../engine/status";

/** The permission that exempts a person from the gate (IT / super-admin proxy). */
export const EXEMPT_PERMISSION = "admin.access";

export type OnboardingTask = {
  key: OnboardingTaskKey;
  label: string;
  description: string;
  href: string;
  ctaLabel: string;
  state: OnboardingTaskState;
};

export type OnboardingStatus = {
  hasActiveTerm: boolean;
  exempt: boolean;
  tasks: OnboardingTask[];
  completedCount: number;
  totalCount: number;
  onboarded: boolean;
};

/** Static presentation copy per task (HAVEN voice; sentence case; no em-dashes). */
const COPY: Record<OnboardingTaskKey, { label: string; description: string; href: string; ctaLabel: string }> = {
  profile: {
    label: "Profile & agreements",
    description: "Confirm your contact details so we can reach you about shifts.",
    href: "/my-info",
    ctaLabel: "Complete profile",
  },
  hipaa: {
    label: "HIPAA certificate",
    description: "Upload your current HIPAA certificate so we can verify it is valid through the term.",
    href: "/my-info",
    ctaLabel: "Upload certificate",
  },
  training: {
    label: "Volunteer training",
    description: "Finish this term's training to be cleared for shifts.",
    href: "/training",
    ctaLabel: "Go to training",
  },
  learning: {
    label: "Learning modules",
    description: "Complete the courses your department assigned to you.",
    href: "/learning",
    ctaLabel: "Open courses",
  },
};

function task(key: OnboardingTaskKey, state: OnboardingTaskState): OnboardingTask {
  return { key, state, ...COPY[key] };
}

/**
 * Compute a person's onboarding clearance for the active term. Returns a dormant
 * (onboarded:true) status when there is no active term, so the gate never blocks.
 */
export async function getOnboardingStatus(personId: string): Promise<OnboardingStatus> {
  const exempt = await can(personId, EXEMPT_PERMISSION);

  const term = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  if (!term) {
    return { hasActiveTerm: false, exempt, tasks: [], completedCount: 0, totalCount: 0, onboarded: true };
  }

  const [person, certs, training, courses] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { contactEmail: true, phone: true } }),
    listMyCertificates(personId),
    getMyTraining(personId), // safe: active term exists
    getMyCourses(personId),
  ]);

  const tasks: OnboardingTask[] = [
    task("profile", deriveProfileTaskState(person)),
    task("hipaa", deriveHipaaTaskState(complianceStatus(certs[0] ?? null, term.endDate))),
    task("training", deriveTrainingTaskState({ state: training.state, attemptsUsed: training.attemptsUsed })),
    task("learning", deriveLearningTaskState(courses)),
  ];

  const { completedCount, totalCount, onboarded } = summarize(tasks.map((t) => t.state));
  return { hasActiveTerm: true, exempt, tasks, completedCount, totalCount, onboarded };
}
