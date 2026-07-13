import {
  CalendarDays,
  Repeat,
  UserRoundPen,
  GraduationCap,
  ClipboardCheck,
  type LucideIcon,
} from "lucide-react";
import type { ComplianceStatus } from "@/platform/compliance/rules";

export type ActionCard = {
  key: string;
  href: string;
  icon: LucideIcon;
  hue: string; // a --mod-<hue> token key
  label: string;
  sub: string;
  priority: number; // ranking only; not rendered
};

export type ActionCardInput = {
  hasScheduleAccess: boolean;
  hasMyInfoAccess: boolean;
  upcomingCount: number;
  nextShiftDaysAway: number | null; // null when no upcoming shift
  pendingSwapCount: number;
  pendingApprovals: number;
  compliance: ComplianceStatus;
  trainingIncomplete: number;
  trainingHref: string;
  profileIncomplete: boolean;
  backfill: ActionCard[]; // module shortcuts, in preference order, priority 0
  limit?: number; // default 4
};

/**
 * The My info card folds HIPAA and the profile "confirm" task into one /my-info
 * nudge, surfacing only the single most-pressing concern. The side rail still
 * lists the full clearance checklist, so this is intentionally not exhaustive.
 */
function myInfoCard(input: ActionCardInput): ActionCard {
  const base = { key: "my-info", href: "/my-info", icon: UserRoundPen, hue: "info", label: "My info" };
  if (input.compliance === "EXPIRED" || input.compliance === "NO_CERTIFICATE") {
    return { ...base, priority: 90, sub: "Upload HIPAA certificate" };
  }
  if (input.profileIncomplete) {
    return { ...base, priority: 85, sub: "1 to confirm" };
  }
  if (input.compliance === "EXPIRING_SOON") {
    return { ...base, priority: 70, sub: "Renew HIPAA soon" };
  }
  if (input.compliance === "PENDING_VERIFICATION" || input.compliance === "UNKNOWN_DATE") {
    return { ...base, priority: 40, sub: "HIPAA in review" };
  }
  return { ...base, priority: 20, sub: "View & update" };
}

function scheduleCard(input: ActionCardInput): ActionCard {
  const base = { key: "schedule", href: "/schedule", icon: CalendarDays, hue: "schedule", label: "Schedule" };
  const d = input.nextShiftDaysAway;
  if (d != null && d <= 2) {
    const sub = d <= 0 ? "Today" : d === 1 ? "Tomorrow" : `In ${d} days`;
    return { ...base, priority: 60, sub };
  }
  const sub = input.upcomingCount > 0 ? `${input.upcomingCount} upcoming` : "View shifts";
  return { ...base, priority: 30, sub };
}

function swapCard(input: ActionCardInput): ActionCard {
  const base = { key: "swap", href: "/schedule", icon: Repeat, hue: "swap", label: "Request a swap" };
  if (input.pendingSwapCount > 0) {
    return { ...base, priority: 40, sub: `${input.pendingSwapCount} pending` };
  }
  return { ...base, priority: 25, sub: "Find cover" };
}

/**
 * Ranked smart action feed for the dashboard. Pure: all inputs are plain data,
 * so this is unit-tested without a database. Real (personal + role) actions rank
 * by urgency; module shortcuts in `backfill` fill any remaining slots. Capped at
 * `limit` (default 4). Array.sort is stable, so equal-priority cards keep their
 * insertion order.
 */
export function buildActionCards(input: ActionCardInput): ActionCard[] {
  const cards: ActionCard[] = [];

  if (input.pendingApprovals > 0) {
    cards.push({
      key: "approvals",
      href: "/schedule/builder",
      icon: ClipboardCheck,
      hue: "admin",
      label: "Approvals",
      sub: `${input.pendingApprovals} to review`,
      priority: 95,
    });
  }

  if (input.hasMyInfoAccess) {
    cards.push(myInfoCard(input));
  }

  if (input.trainingIncomplete > 0) {
    cards.push({
      key: "training",
      href: input.trainingHref,
      icon: GraduationCap,
      hue: "recruit",
      label: "Training",
      sub: input.trainingIncomplete === 1 ? "To complete" : `${input.trainingIncomplete} to complete`,
      priority: 80,
    });
  }

  if (input.hasScheduleAccess) {
    cards.push(scheduleCard(input));
    if (input.upcomingCount > 0) {
      cards.push(swapCard(input));
    }
  }

  cards.sort((a, b) => b.priority - a.priority);

  const limit = input.limit ?? 4;
  return [...cards, ...input.backfill].slice(0, limit);
}
