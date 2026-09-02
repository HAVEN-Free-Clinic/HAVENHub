import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { loadComplianceStatusMap, loadHipaaExpiryMap } from "@/platform/compliance/status";
import { loadClearanceMap, type ClearanceSummary } from "@/platform/clearance";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import type { Audience, AudienceCondition, AudienceNode } from "./types";
import { isAudienceGroup } from "./types";
import { compilePersonWhere } from "./compile";
import { personVariables } from "./variables";
import { asArray } from "./operators";
import { COUNT_LOADERS } from "./person-fields";

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
 * Applicant facts resolved to person ids, bucketed several ways.
 *
 * `appliedByCycle` and `acceptedByCycle` are keyed by cycle id, `bySubcommittee`
 * by subcommittee id -- all three pre-seeded identically from their requested-id
 * arrays (see loadApplicantFacts below), each id mapped to an empty Set before
 * any applicant row is scanned. That pre-seeding is what makes the
 * `bySubcommittee.has(...)` guard downstream correct: it is a "was this id one
 * of the ones the audience actually asked about" filter, and it only works
 * because every requested id is already a key -- not built lazily as applicants
 * matching it are found -- so a subcommittee the audience never named can never
 * pass the check no matter what an applicant's row references.
 */
type ApplicantFacts = {
  /** Person ids with any submitted application, keyed by cycle id. */
  appliedByCycle: Map<string, Set<string>>;
  /** Person ids whose application in that cycle has at least one Acceptance. */
  acceptedByCycle: Map<string, Set<string>>;
  /** Person ids assigned to each subcommittee, keyed by subcommittee id. */
  bySubcommittee: Map<string, Set<string>>;
};

/**
 * Resolves applications to person ids ONCE, then buckets the result by cycle
 * (applied / accepted) and by subcommittee.
 *
 * An application does not reliably link to a Person: `Applicant.applicantPersonId`
 * is set only for signed-in renewals and is null for everyone who applied
 * anonymously. Matching only the link would quietly UNDER-match, which on an
 * "exclude people who already applied" condition means re-nagging exactly the
 * people who did the thing you asked. So unlinked applicants are matched back to
 * a Person by email (case-insensitively) and by NetID. Every bucket below
 * reuses that one resolution rather than adding a second, weaker one.
 *
 * The one-off scan of `Person` is deliberate: Prisma ignores `mode: "insensitive"`
 * on `in` for Postgres, so a case-insensitive bulk email match cannot be pushed
 * into the query. The table is clinic-sized and this runs only when one of the
 * fields backed by this precompute is actually present in the audience.
 */
async function loadApplicantFacts(
  cycleIds: string[],
  subcommitteeIds: string[],
): Promise<ApplicantFacts> {
  const appliedByCycle = new Map<string, Set<string>>(cycleIds.map((id) => [id, new Set<string>()]));
  const acceptedByCycle = new Map<string, Set<string>>(cycleIds.map((id) => [id, new Set<string>()]));
  const bySubcommittee = new Map<string, Set<string>>(
    subcommitteeIds.map((id) => [id, new Set<string>()]),
  );
  const wantSubcommittees = subcommitteeIds.length > 0;
  if (cycleIds.length === 0 && !wantSubcommittees) {
    return { appliedByCycle, acceptedByCycle, bySubcommittee };
  }

  const applicants = await prisma.applicant.findMany({
    where: {
      OR: [
        ...(cycleIds.length > 0 ? [{ cycleId: { in: cycleIds } }] : []),
        ...(wantSubcommittees
          ? [{ applications: { some: { assignedSubcommitteeId: { in: subcommitteeIds } } } }]
          : []),
      ],
      applications: { some: {} },
    },
    select: {
      cycleId: true,
      applicantPersonId: true,
      emailLower: true,
      netId: true,
      applications: {
        select: {
          id: true,
          assignedSubcommitteeId: true,
          acceptances: { select: { id: true } },
        },
      },
    },
  });
  if (applicants.length === 0) return { appliedByCycle, acceptedByCycle, bySubcommittee };

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
    if (!personId) continue;

    if (appliedByCycle.has(a.cycleId)) appliedByCycle.get(a.cycleId)!.add(personId);

    const hasAcceptance = a.applications.some((app) => app.acceptances.length > 0);
    if (hasAcceptance && acceptedByCycle.has(a.cycleId)) {
      acceptedByCycle.get(a.cycleId)!.add(personId);
    }

    if (wantSubcommittees) {
      for (const app of a.applications) {
        if (app.assignedSubcommitteeId && bySubcommittee.has(app.assignedSubcommitteeId)) {
          bySubcommittee.get(app.assignedSubcommitteeId)!.add(personId);
        }
      }
    }
  }
  return { appliedByCycle, acceptedByCycle, bySubcommittee };
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
  // `now` is threaded through so the EXPIRED/COMPLIANT/EXPIRING_SOON thresholds
  // resolve against the run's own pinned clock, the same as everything else in
  // this function -- getActiveTerm() resolves off a stored ACTIVE flag with no
  // clock dependency of its own, so this creates no new coupling with the
  // term-end boundary math inside complianceStatus.
  const needsCompliance = conditions.some((c) => c.field === "complianceStatus");
  const complianceStatusByPerson = needsCompliance
    ? await loadComplianceStatusMap(activeTerm?.endDate ?? null, now)
    : undefined;

  // Certificate expiry is likewise derived (completion date + validity period,
  // via the SAME effective-certificate selection complianceStatus uses -- see
  // loadHipaaExpiryMap), so it takes the identical precompute-only-when-named
  // route, `now` threaded through the same way: hipaaExpiresAt is compared with
  // withinNextDays/withinLastDays, which must re-evaluate against the run's own
  // clock for a recurring campaign to mean something different on each send
  // (see AudienceCtx.now's doc comment).
  const needsHipaaExpiry = conditions.some((c) => c.field === "hipaaExpiresAt");
  const hipaaExpiresAtByPerson = needsHipaaExpiry
    ? await loadHipaaExpiryMap(activeTerm?.endDate ?? null, now)
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
  // cycles and subcommittees the audience actually names are loaded, and only
  // when one of the three fields backed by this precompute is present.
  const wantedCycleIds = [
    ...new Set(
      conditions
        .filter((c) => c.field === "appliedToCycle" || c.field === "acceptedInCycle")
        .flatMap((c) => asArray(c.value)),
    ),
  ];
  const wantedSubcommitteeIds = [
    ...new Set(
      conditions.filter((c) => c.field === "subcommittee").flatMap((c) => asArray(c.value)),
    ),
  ];
  const needsApplicantFacts = conditions.some(
    (c) => c.field === "appliedToCycle" || c.field === "acceptedInCycle" || c.field === "subcommittee",
  );
  const applicantFacts = needsApplicantFacts
    ? await loadApplicantFacts(wantedCycleIds, wantedSubcommitteeIds)
    : undefined;

  // Count fields each cost a scan, so run only the loaders the audience (or its
  // scope) actually names. `conditions` already spans both trees.
  const countFieldKeys = [
    ...new Set(conditions.map((c) => c.field).filter((f) => f in COUNT_LOADERS)),
  ];
  const countsByField = new Map<string, Map<string, number>>();
  for (const key of countFieldKeys) {
    countsByField.set(
      key,
      await COUNT_LOADERS[key]({ activeTermId: activeTerm?.id ?? null, now, zone }),
    );
  }

  const ctx = {
    activeTermId: activeTerm?.id ?? null,
    now,
    zone,
    complianceStatusByPerson,
    hipaaExpiresAtByPerson,
    clearanceByPerson,
    appliedByCycle: applicantFacts?.appliedByCycle,
    acceptedByCycle: applicantFacts?.acceptedByCycle,
    bySubcommittee: applicantFacts?.bySubcommittee,
    countsByField,
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
