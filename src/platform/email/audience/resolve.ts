import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { loadComplianceStatusMap, loadHipaaExpiryMap } from "@/platform/compliance/status";
import { loadClearanceMap, type ClearanceSummary } from "@/platform/clearance";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import type { Prisma } from "@prisma/client";
import type { Audience, AudienceCondition, AudienceNode } from "./types";
import { isAudienceGroup, EMPTY_AUDIENCE } from "./types";
import { compileNodeWhere, compilePersonWhere } from "./compile";
import type { AudienceCtx } from "./person-fields";
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
 * Build the compile context ONCE for an audience and (optionally) the scope it
 * is bounded by.
 *
 * Shared by resolveAudience and countAudienceNodes rather than duplicated:
 * every precompute below is gated on a field actually being NAMED by one of the
 * two trees, and that gating has to see both trees. A second copy of this
 * detection that drifted would not fail loudly -- it would hand the field
 * compiler an undefined map for a condition it did not notice, which resolves
 * to match-nobody under ALL/ANY and, inside a NONE group, to everybody.
 */
async function buildAudienceCtx(
  audience: Audience,
  scope: Audience | null | undefined,
  now: Date,
): Promise<AudienceCtx> {
  const activeTerm = await getActiveTerm();
  const zone = await getDisplayTimeZone();
  // Precompute detection must span BOTH trees. A condition that appears only in
  // the scope still needs its precomputed map, or the field compiler resolves
  // the scope half against an undefined map.
  const conditions = [
    ...collectConditions(audience.conditions),
    ...(scope ? collectConditions(scope.conditions) : []),
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

  return {
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
  const ctx = await buildAudienceCtx(audience, opts.scope, opts.now ?? new Date());
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

/** One person a scoped search may offer, in the shape the builder renders. */
export type PersonSearchHit = { personId: string; name: string; email: string };

/**
 * How many hits one search returns, and the shortest query that runs at all.
 *
 * Neither is a security boundary -- the scope below is -- but a one-character
 * query would scan the whole in-scope roster on every keystroke to render a
 * list nobody can use, so it is refused instead.
 */
export const PERSON_SEARCH_LIMIT = 25;
export const MIN_PERSON_SEARCH_LENGTH = 2;

/**
 * People matching a free-text query, bounded by an audience the results may not
 * escape.
 *
 * `opts.scope` is the same parameter resolveAudience and countAudienceNodes
 * take and is applied the same way: compiled independently and intersected at
 * the ROOT of the where, never appended as a sibling condition. This is the
 * scope-bounded half of the manual-include control, and the bound matters as
 * much here as it does for a count or a send: an unscoped search would let a
 * scoped sender enumerate the entire directory a letter at a time, and learning
 * who EXISTS is the leak even when the eventual send stays scope-filtered.
 *
 * WHICH scope applies is decided by searchAudiencePeople in
 * campaigns/service.ts, which reads it from the campaign row. Nothing above
 * this function ever takes a scope from a client, and there is deliberately no
 * entry point that would let one.
 *
 * People with no usable address are left out. Adding one to a campaign does
 * nothing except grow the "excluded, no email" count, so offering them would
 * only invite a manual include that silently does nothing.
 */
export async function searchPeople(
  query: string,
  opts: { scope?: Audience | null; now?: Date } = {},
): Promise<PersonSearchHit[]> {
  const q = query.trim();
  if (q.length < MIN_PERSON_SEARCH_LENGTH) return [];

  // No campaign tree of its own to precompute for: the only conditions in play
  // are the scope's, which buildAudienceCtx collects from its second argument.
  const ctx = await buildAudienceCtx(EMPTY_AUDIENCE, opts.scope, opts.now ?? new Date());
  const scopeWhere = opts.scope ? compilePersonWhere(opts.scope, ctx) : null;

  const matches: Prisma.PersonWhereInput = {
    // "Has a usable address" asked in the QUERY, not applied to the rows that
    // come back. Applied afterwards it runs AFTER `take`, so people whose
    // address is set but blank consume result slots and the search reports
    // nothing while in-scope matches sit just past the cap.
    //
    // Spelled as `contains: "@"` because no Prisma string filter can express
    // "trims to non-empty", and whitespace-only is the spelling that matters:
    // contactEmail is @unique, so at most ONE row can hold "" and it could
    // waste at most one slot, while "  ", "   " and so on are distinct values
    // that can fill every slot. A NULL address never satisfies `contains`
    // either, so this one predicate covers all three spellings of "blank".
    //
    // The cost of asking it this way: a non-blank address with no "@" stops
    // being offered for manual add. Nothing can deliver such a value anyway, so
    // the search would only be offering a person the send path will drop.
    contactEmail: { contains: "@" },
    OR: [
      { name: { contains: q, mode: "insensitive" } },
      { contactEmail: { contains: q, mode: "insensitive" } },
    ],
  };

  const people = await prisma.person.findMany({
    where: scopeWhere ? { AND: [scopeWhere, matches] } : matches,
    select: { id: true, name: true, contactEmail: true },
    orderBy: { name: "asc" },
    take: PERSON_SEARCH_LIMIT,
  });

  // Trimmed to match what the send path would actually use as the address.
  return people.map((p) => ({
    personId: p.id,
    name: p.name,
    email: (p.contactEmail ?? "").trim(),
  }));
}

/**
 * The most nodes (root included) a single count request will fan out over.
 *
 * Each node costs its own `prisma.person.count`, and the builder re-counts on
 * every edit, so an unbounded tree turns one debounced keystroke into dozens of
 * queries against the shared connection pool. A tree past the budget yields NO
 * counts at all rather than a partial map: a builder showing counts on the
 * first forty clauses and blanks on the rest reads as "those clauses match
 * nobody", which is precisely the misreading the counts exist to prevent.
 *
 * Forty is well above any hand-built audience (the deepest one in the starters
 * has six nodes) and low enough that the worst case stays a fraction of a
 * second.
 */
export const MAX_COUNTED_NODES = 40;

/** The key for the whole tree, distinct from any index-derived child path. */
export const ROOT_NODE_PATH = "root";

/**
 * Every node of the tree paired with its stable path key.
 *
 * The path is positional: root-level children are "0", "1", ...; a child of the
 * node at "1" is "1.0". The builder derives the same key from the same indices
 * as it renders (see childNodePath and nodePaths in
 * `src/app/(app)/outreach/campaigns/[id]/node-paths.ts`), which is what lets one
 * server round trip address every row on the client. That duplication is
 * deliberate (this module reaches into prisma and must stay out of the client
 * bundle), so this cross-reference is the only thing linking the two.
 *
 * Exported solely so node-paths.test.ts can compare the two walks directly
 * rather than each against its own hardcoded literal, which is a guard that
 * passes while the halves disagree. Nothing else should call it: callers want
 * countAudienceNodes.
 */
export function enumerateNodes(audience: Audience): { path: string; node: AudienceNode }[] {
  const out: { path: string; node: AudienceNode }[] = [
    // The root is a group in every respect except that Audience spells its two
    // halves as `match` + `conditions`, so it is counted through the same
    // node compiler as everything else rather than a special case.
    { path: ROOT_NODE_PATH, node: { match: audience.match, children: audience.conditions } },
  ];
  const walk = (nodes: AudienceNode[], prefix: string) => {
    nodes.forEach((node, i) => {
      const path = prefix === ROOT_NODE_PATH ? String(i) : `${prefix}.${i}`;
      out.push({ path, node });
      if (isAudienceGroup(node)) walk(node.children, path);
    });
  };
  walk(audience.conditions, ROOT_NODE_PATH);
  return out;
}

/**
 * How many people each node of the tree matches, keyed by node path.
 *
 * `opts.scope` bounds EVERY node, not merely the root, and it is intersected at
 * the root of each node's `where` exactly as resolveAudience intersects it for
 * a send. That is the whole security property of this function: the counts are
 * live and per-node, so a scoped sender who could see an unscoped number for
 * even one clause could binary-search the rest of the directory by editing that
 * clause and watching the number move. Callers must therefore pass the scope
 * that governs the campaign, never one derived from anything the client sent
 * (see countAudienceNodes in campaigns/service.ts).
 *
 * A node's count is the count of its own compiled fragment, with no per-node
 * adjustment. A NONE group is `NOT { OR: children }`, so its count is everyone
 * in scope matching none of its children -- typically a number LARGER than the
 * audience it sits inside. That is deliberate: three send-all bugs on this
 * branch came from a NONE group silently inverting to match everybody, and a
 * count that shows the widening is the first thing that makes it visible. The
 * builder labels it so the number cannot be read as an addition.
 *
 * Counted with `prisma.person.count` rather than by resolving recipients: only
 * the number is wanted, and materialising rows per node would multiply the cost
 * of a keystroke by the size of the roster.
 *
 * What `root` therefore is, exactly: **the number of people the campaign's
 * AUDIENCE CONDITIONS match within its scope**. It is not the number the
 * campaign will email, and must not be documented as such. Every one of these
 * moves the real roll and none is expressible in a count query:
 * resolveCampaignAudience additionally drops anyone with no email address,
 * dedups by lowercased address, unions in `includePersonIds` and
 * `pastedEmails` (themselves re-filtered through the scope), subtracts
 * `excludePersonIds`, and for a `sendOncePerPerson` campaign subtracts everyone
 * a prior run already mailed. That last one is reachable today, since the
 * send-once toggle is already exposed in Timing: after the first run of a
 * send-once campaign `root` will exceed both the preview and the actual send.
 * `previewAudience` is the authority on how many messages go out, and the
 * builder's own copy says so.
 *
 * Sequential on purpose. The fan-out is already bounded by MAX_COUNTED_NODES,
 * and firing forty concurrent queries would saturate a connection pool shared
 * with every other request the instance is serving, to save time on a request
 * that is debounced and decorative.
 */
export async function countAudienceNodes(
  audience: Audience,
  opts: { scope?: Audience | null; now?: Date } = {},
): Promise<Record<string, number>> {
  const nodes = enumerateNodes(audience);
  if (nodes.length > MAX_COUNTED_NODES) return {};

  const ctx = await buildAudienceCtx(audience, opts.scope, opts.now ?? new Date());
  const scopeWhere = opts.scope ? compilePersonWhere(opts.scope, ctx) : null;

  const counts: Record<string, number> = {};
  for (const { path, node } of nodes) {
    const nodeWhere = compileNodeWhere(node, ctx);
    counts[path] = await prisma.person.count({
      where: scopeWhere ? { AND: [scopeWhere, nodeWhere] } : nodeWhere,
    });
  }
  return counts;
}
