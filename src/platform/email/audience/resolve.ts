import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { loadComplianceStatusMap } from "@/platform/compliance/status";
import { loadClearanceMap, type ClearanceSummary } from "@/platform/clearance";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import type { Audience, AudienceCondition, AudienceNode } from "./types";
import { isAudienceGroup } from "./types";
import { compilePersonWhere } from "./compile";
import { personVariables } from "./variables";
import { asArray } from "./operators";

export type Recipient = {
  email: string;
  displayName: string;
  recordType: "PERSON";
  recordId: string;
  variables: Record<string, string>;
};

export type ResolvedAudience = { recipients: Recipient[]; excludedNoEmail: number };

/** Flatten the audience tree to its leaf conditions, for precompute detection. */
function collectConditions(nodes: AudienceNode[]): AudienceCondition[] {
  const out: AudienceCondition[] = [];
  for (const node of nodes) {
    if (isAudienceGroup(node)) out.push(...collectConditions(node.children));
    else out.push(node);
  }
  return out;
}

/**
 * Person ids with an application in each of `cycleIds`.
 *
 * An application does not reliably link to a Person: `Applicant.applicantPersonId`
 * is set only for signed-in renewals and is null for everyone who applied
 * anonymously. Matching only the link would quietly UNDER-match, which on an
 * "exclude people who already applied" condition means re-nagging exactly the
 * people who did the thing you asked. So unlinked applicants are matched back to
 * a Person by email (case-insensitively) and by NetID.
 *
 * The one-off scan of `Person` is deliberate: Prisma ignores `mode: "insensitive"`
 * on `in` for Postgres, so a case-insensitive bulk email match cannot be pushed
 * into the query. The table is clinic-sized and this runs only when an
 * `appliedToCycle` condition is present.
 */
async function loadAppliedByCycle(cycleIds: string[]): Promise<Map<string, Set<string>>> {
  const byCycle = new Map<string, Set<string>>(cycleIds.map((id) => [id, new Set<string>()]));
  if (cycleIds.length === 0) return byCycle;

  const applicants = await prisma.applicant.findMany({
    where: { cycleId: { in: cycleIds }, applications: { some: {} } },
    select: { cycleId: true, applicantPersonId: true, emailLower: true, netId: true },
  });
  if (applicants.length === 0) return byCycle;

  const people = await prisma.person.findMany({
    select: { id: true, contactEmail: true, netId: true },
  });
  const byEmail = new Map<string, string>();
  const byNetId = new Map<string, string>();
  for (const p of people) {
    const email = p.contactEmail?.trim().toLowerCase();
    if (email) byEmail.set(email, p.id);
    const netId = p.netId?.trim().toLowerCase();
    if (netId) byNetId.set(netId, p.id);
  }

  for (const a of applicants) {
    const personId =
      a.applicantPersonId ??
      byEmail.get(a.emailLower.trim().toLowerCase()) ??
      (a.netId ? byNetId.get(a.netId.trim().toLowerCase()) : undefined);
    if (personId) byCycle.get(a.cycleId)?.add(personId);
  }
  return byCycle;
}

/**
 * Resolve an audience to its recipients.
 *
 * `opts.scope`, when present, is an audience the result may not escape: the two
 * trees compile independently and are intersected at the ROOT of the Prisma
 * where. Appending the scope as a sibling condition instead would be a security
 * bug, because a campaign whose root match is ANY would OR the scope straight
 * back out and mail everyone.
 *
 * `opts.now`, when present, pins the clock date conditions resolve against;
 * tests use it to pin a fixed instant. In production it is left unset, so every
 * run (recurring campaigns included) resolves relative date windows against the
 * real clock at send time, not a value frozen when the audience was saved.
 */
export async function resolveAudience(
  audience: Audience,
  opts: { scope?: Audience | null; now?: Date } = {},
): Promise<ResolvedAudience> {
  const activeTerm = await getActiveTerm();
  const now = opts.now ?? new Date();
  const zone = await getDisplayTimeZone();
  // Precompute detection must span BOTH trees. A condition that appears only in
  // the scope still needs its precomputed map, or the field compiler resolves
  // the scope half against an undefined map.
  const conditions = [
    ...collectConditions(audience.conditions),
    ...(opts.scope ? collectConditions(opts.scope.conditions) : []),
  ];

  // Compliance status is derived live (newest cert + term end), so it can't be a
  // Prisma predicate. Precompute the per-person status map only when a condition
  // needs it, then let the field compiler resolve selected statuses to ids.
  const needsCompliance = conditions.some((c) => c.field === "complianceStatus");
  const complianceStatusByPerson = needsCompliance
    ? await loadComplianceStatusMap(activeTerm?.endDate ?? null)
    : undefined;

  // Clearance (full onboarding status) is likewise derived. Precompute it per
  // active-term member when an isCleared/learningComplete condition is present.
  // With no active term nobody is cleared, so an empty map matches nobody rather
  // than throwing in the field compiler.
  const needsClearance = conditions.some(
    (c) => c.field === "isCleared" || c.field === "learningComplete",
  );
  let clearanceByPerson: Map<string, ClearanceSummary> | undefined;
  if (needsClearance) {
    if (activeTerm) {
      const memberIds = [
        ...new Set(
          (
            await prisma.termMembership.findMany({
              where: { termId: activeTerm.id, status: "ACTIVE" },
              select: { personId: true },
            })
          ).map((m) => m.personId),
        ),
      ];
      clearanceByPerson = await loadClearanceMap(memberIds, activeTerm.id);
    } else {
      clearanceByPerson = new Map();
    }
  }

  // Recruitment applications reach a Person through a nullable link plus an
  // email/NetID fallback, so they cannot be a Prisma predicate either. Only the
  // cycles the audience actually names are loaded.
  const wantedCycleIds = [
    ...new Set(
      conditions.filter((c) => c.field === "appliedToCycle").flatMap((c) => asArray(c.value)),
    ),
  ];
  const appliedByCycle = conditions.some((c) => c.field === "appliedToCycle")
    ? await loadAppliedByCycle(wantedCycleIds)
    : undefined;

  const ctx = {
    activeTermId: activeTerm?.id ?? null,
    now,
    zone,
    complianceStatusByPerson,
    clearanceByPerson,
    appliedByCycle,
  };
  const campaignWhere = compilePersonWhere(audience, ctx);
  const where = opts.scope
    ? { AND: [compilePersonWhere(opts.scope, ctx), campaignWhere] }
    : campaignWhere;
  const people = await prisma.person.findMany({
    where,
    select: { id: true, name: true, contactEmail: true },
    orderBy: { name: "asc" },
  });

  const recipients: Recipient[] = [];
  let excludedNoEmail = 0;
  for (const p of people) {
    const email = p.contactEmail?.trim() ?? "";
    if (email === "") { excludedNoEmail++; continue; }
    recipients.push({
      email,
      displayName: p.name,
      recordType: "PERSON",
      recordId: p.id,
      variables: personVariables({ name: p.name }),
    });
  }
  return { recipients, excludedNoEmail };
}
