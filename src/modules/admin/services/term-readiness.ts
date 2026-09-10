/**
 * What activating a term will do, measured before anyone presses the button.
 *
 * activateTerm is one small transaction, but a great deal re-anchors on the term
 * it activates: permissions (department- and kind-targeted grants resolve
 * through the ACTIVE term, and a term-scoped assignment only counts while its
 * term is ACTIVE), the onboarding gate, every offboarding surface, the Saturday
 * reminder and check-in jobs, and which drafted shifts members can see. Each of
 * those was found the hard way while preparing the SU26 to FA26 flip, the first
 * one run in-app, and none of them was visible from the activate screen.
 *
 * Read-only. Nothing here blocks activation: the page shows it and the admin
 * decides.
 */

import type { Term } from "@prisma/client";
import { prisma } from "@/platform/db";
import { loadClearanceMap, type OnboardingTaskKey } from "@/platform/clearance";
import { effectivePermissionHolderIds } from "@/platform/rbac/permission-holders";
import { displayTodayKey } from "@/platform/dates/today";
import { isoDateKey } from "@/platform/dates";
import { displacedStatusFor } from "./terms";

/**
 * The onboarding gate's exemption. It is EXEMPT_PERMISSION in the onboarding
 * module, which this module may not import; the value is the gate's contract
 * (see enforceOnboarding in platform/auth/session.ts).
 */
const GATE_EXEMPT_PERMISSION = "admin.access";

export type OutgoingReadiness = {
  id: string;
  code: string;
  name: string;
  endDate: Date;
  /** What the swap will do to it: ARCHIVED once it has ended, PLANNING before. */
  becomes: "ARCHIVED" | "PLANNING";
  /** Its clinic dates on or after today (display-zone day), soonest first. */
  remainingClinicDates: Date[];
  pendingRequests: number;
  /**
   * ACTIVE people on its roster with no ACTIVE place on the incoming one.
   * After activation every offboarding surface reads the new term, so these
   * people appear on none of them.
   */
  notContinuing: number;
  /** Role assignments scoped to this term, which stop granting on activation. */
  termScopedRoles: Array<{ roleName: string; count: number }>;
};

export type IncomingReadiness = {
  /** Accepted applicants in this term's cycles who are not on its roster yet. */
  unpromoted: Array<{ cycleId: string; title: string; count: number }>;
  /** ACTIVE people with an ACTIVE place on this term's roster. */
  members: number;
  /** Of those, how many the onboarding gate would stop once this term is live. */
  heldAtGate: number;
  /** Each blocking step, with how many of the held people are missing it. */
  heldBySteps: Array<{ key: OnboardingTaskKey; count: number }>;
  /**
   * Departments with drafted shifts but no published schedule. The live term is
   * never publication-gated, so activation shows every such draft to members
   * and puts it in the shift-reminder stream.
   */
  unpublishedDepartments: string[];
};

export type ActivationReadiness = {
  /** The term activation would displace, or null when none is ACTIVE. */
  outgoing: OutgoingReadiness | null;
  incoming: IncomingReadiness;
};

export async function activationReadiness(
  targetTermId: string,
  now: Date = new Date(),
): Promise<ActivationReadiness> {
  const [target, current] = await Promise.all([
    prisma.term.findUniqueOrThrow({ where: { id: targetTermId } }),
    prisma.term.findFirst({
      where: { status: "ACTIVE", id: { not: targetTermId } },
      orderBy: { startDate: "desc" },
    }),
  ]);
  const [outgoing, incoming] = await Promise.all([
    current ? outgoingReadiness(current, target.id, now) : Promise.resolve(null),
    incomingReadiness(target, now),
  ]);
  return { outgoing, incoming };
}

async function outgoingReadiness(
  term: Term,
  incomingTermId: string,
  now: Date,
): Promise<OutgoingReadiness> {
  const [todayKey, pendingRequests, members, continuing, scoped] = await Promise.all([
    displayTodayKey(now),
    prisma.shiftRequest.count({ where: { termId: term.id, status: "PENDING" } }),
    prisma.termMembership.findMany({
      where: { termId: term.id, status: "ACTIVE", person: { status: "ACTIVE" } },
      select: { personId: true },
      distinct: ["personId"],
    }),
    prisma.termMembership.findMany({
      where: { termId: incomingTermId, status: "ACTIVE" },
      select: { personId: true },
      distinct: ["personId"],
    }),
    prisma.roleAssignment.findMany({
      where: { termId: term.id },
      select: { role: { select: { name: true } } },
    }),
  ]);

  const continuingIds = new Set(continuing.map((m) => m.personId));
  const roleCounts = new Map<string, number>();
  for (const a of scoped) roleCounts.set(a.role.name, (roleCounts.get(a.role.name) ?? 0) + 1);

  return {
    id: term.id,
    code: term.code,
    name: term.name,
    endDate: term.endDate,
    becomes: displacedStatusFor(term, now),
    // Clinic dates are anchored at 12:00 UTC, so their UTC day key is the
    // clinic's calendar day and compares directly with the display-zone today.
    remainingClinicDates: term.clinicDates
      .filter((d) => isoDateKey(d) >= todayKey)
      .sort((a, b) => a.getTime() - b.getTime()),
    pendingRequests,
    notContinuing: members.filter((m) => !continuingIds.has(m.personId)).length,
    termScopedRoles: [...roleCounts]
      .map(([roleName, count]) => ({ roleName, count }))
      .sort((a, b) => a.roleName.localeCompare(b.roleName)),
  };
}

async function incomingReadiness(term: Term, now: Date): Promise<IncomingReadiness> {
  const [acceptances, memberships, drafted, published, exempt] = await Promise.all([
    prisma.acceptance.findMany({
      where: {
        // A withdrawn applicant keeps their acceptance by design and must never
        // be promoted, so they are not waiting on anything.
        application: { status: { not: "WITHDRAWN" }, cycle: { termId: term.id } },
        OR: [{ contract: { is: null } }, { contract: { is: { status: { not: "PROMOTED" } } } }],
      },
      select: { application: { select: { cycle: { select: { id: true, title: true } } } } },
    }),
    prisma.termMembership.findMany({
      where: { termId: term.id, status: "ACTIVE", person: { status: "ACTIVE" } },
      select: { personId: true },
      distinct: ["personId"],
    }),
    prisma.shiftAssignment.findMany({
      where: { termId: term.id },
      select: { departmentId: true },
      distinct: ["departmentId"],
    }),
    prisma.schedulePublication.findMany({
      where: { termId: term.id },
      select: { departmentId: true },
    }),
    // Resolved AS OF this term: department- and kind-targeted grants follow the
    // memberships in whichever term is active, so who is exempt after the flip
    // is decided by this term's roster, not the current one.
    effectivePermissionHolderIds(prisma, GATE_EXEMPT_PERMISSION, { id: term.id }),
  ]);

  const byCycle = new Map<string, { cycleId: string; title: string; count: number }>();
  for (const a of acceptances) {
    const { id, title } = a.application.cycle;
    const entry = byCycle.get(id) ?? { cycleId: id, title, count: 0 };
    entry.count += 1;
    byCycle.set(id, entry);
  }

  // The gate only stops people on the live roster and never an exempt one (see
  // enforceOnboarding), so those are the people to measure. One caveat carried
  // over from loadClearanceMap: while this term is not yet active it leaves out
  // PER_TERM courses, which cannot be completed for it until it is, so the
  // learning step can only be undercounted here, never overcounted.
  const candidates = memberships.map((m) => m.personId).filter((id) => !exempt.has(id));
  const clearance = await loadClearanceMap(candidates, term.id, now);
  let heldAtGate = 0;
  const stepCounts = new Map<OnboardingTaskKey, number>();
  for (const summary of clearance.values()) {
    if (summary.onboarded) continue;
    heldAtGate += 1;
    for (const task of summary.tasks) {
      if (task.blocking && summary.missing.includes(task.key)) {
        stepCounts.set(task.key, (stepCounts.get(task.key) ?? 0) + 1);
      }
    }
  }

  const publishedIds = new Set(published.map((p) => p.departmentId));
  const unpublishedIds = drafted.map((d) => d.departmentId).filter((id) => !publishedIds.has(id));
  const unpublished = unpublishedIds.length
    ? await prisma.department.findMany({
        where: { id: { in: unpublishedIds } },
        select: { code: true },
        orderBy: { code: "asc" },
      })
    : [];

  return {
    unpromoted: [...byCycle.values()].sort((a, b) => a.title.localeCompare(b.title)),
    members: memberships.length,
    heldAtGate,
    heldBySteps: [...stepCounts]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
    unpublishedDepartments: unpublished.map((d) => d.code),
  };
}
