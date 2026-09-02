import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { validateTemplate } from "@/platform/email/render/validate";
import { isAudience, exceedsAudienceDepth, EMPTY_AUDIENCE } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { PERSON_VARIABLES, personVariables } from "@/platform/email/audience/variables";
import {
  resolveAudience,
  countAudienceNodes as countNodes,
  searchPeople,
} from "@/platform/email/audience/resolve";
import type { Recipient, PersonSearchHit } from "@/platform/email/audience/resolve";
import { renderInlineEmail, loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { queueEmail, queueEmails } from "@/platform/email/send";
import type { Prisma } from "@prisma/client";
import { isValidCron, nextCronAfter, cronMinIntervalMinutes, CAMPAIGN_DISPATCH_CADENCE_MINUTES } from "./cron";
import { getStarter } from "./starters";
import { can } from "@/platform/rbac/engine";
import { getScope, scopesForPerson } from "@/platform/email/audience/scopes";
import type { AudienceScopeView } from "@/platform/email/audience/scopes";
import {
  availableSenderIdentities,
  normalizeSendingAddress,
  resolveCampaignSender,
  resolveSenderIdentity,
} from "@/platform/email/sender-identity";
import type { SenderIdentityOption } from "@/platform/email/sender-identity";
import { log } from "@/platform/logging";

export const CAMPAIGN_CONFIRM_THRESHOLD = 25;

export class CampaignValidationError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Campaign validation failed: ${problems.join("; ")}`);
    this.name = "CampaignValidationError";
    this.problems = problems;
  }
}

export class CampaignConfirmationError extends Error {
  expected: number;
  constructor(expected: number) {
    super(
      `Sending to ${expected} recipients requires confirmation. Pass confirmCount: ${expected} to proceed.`,
    );
    this.name = "CampaignConfirmationError";
    this.expected = expected;
  }
}

/**
 * Thrown when executeRun's atomic claim matches zero rows -- another overlapping
 * pass already dispatched the campaign (or it left the eligible state, e.g. was
 * cancelled) between selection and the claim. Distinct from a genuine failure so
 * dispatchDueCampaigns can treat a lost claim as a benign dedup, not an error.
 */
export class CampaignAlreadyDispatchedError extends Error {
  constructor() {
    super("Campaign already dispatched");
    this.name = "CampaignAlreadyDispatchedError";
  }
}

/**
 * Thrown when a person may not act on a campaign bound to a given scope --
 * viewing, editing, cancelling, previewing, or sending/scheduling it. Every
 * one of those actions shares the same predicate (assertMayActOnScope below),
 * so they all throw this one error rather than each inventing its own.
 */
export class CampaignScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignScopeError";
  }
}

export async function createDraft(
  actorId: string | null,
  name: string,
  opts: { starterId?: string; scopeId?: string | null } = {},
) {
  // A starter seeds the draft's subject + body (and supplies a default name when the
  // creator left it blank). An unknown / omitted starter falls back to an empty draft.
  const starter = opts.starterId ? getStarter(opts.starterId) : undefined;
  return prisma.emailCampaign.create({
    data: {
      name: name || starter?.name || "Untitled campaign",
      createdById: actorId,
      status: "DRAFT",
      scopeId: opts.scopeId ?? null,
      audienceJson: EMPTY_AUDIENCE,
      subject: starter?.subject ?? "",
      body: starter?.body ?? "",
    },
  });
}

export async function getCampaign(id: string) {
  const campaign = await prisma.emailCampaign.findUnique({
    where: { id },
    include: { runs: { orderBy: { runAt: "desc" } } },
  });
  if (!campaign) return null;
  // Attach the ACTUAL EmailLog count per run. recipientCount is recorded when a run is
  // claimed (marked SENT / nextRunAt advanced), but the recipient rows are enqueued
  // AFTER that transaction commits -- a crash in that window leaves a run recorded as
  // sent with fewer (or zero) EmailLog rows and nothing to detect it. Surfacing the
  // real count lets an admin spot an orphaned claim and resend.
  const runIds = campaign.runs.map((r) => r.id);
  const counts = runIds.length
    ? await prisma.emailLog.groupBy({
        by: ["campaignRunId"],
        where: { campaignRunId: { in: runIds } },
        _count: { _all: true },
      })
    : [];
  const byRun = new Map(counts.map((c) => [c.campaignRunId, c._count._all]));
  return {
    ...campaign,
    runs: campaign.runs.map((r) => ({ ...r, enqueuedCount: byRun.get(r.id) ?? 0 })),
  };
}

/**
 * Lists campaigns the caller may act on: everything for an unrestricted
 * sender, or only the campaigns bound to a scope they hold for anyone else. A
 * scoped sender's grants can be empty, in which case `scopeId: { in: [] }`
 * correctly matches nothing -- and, since SQL's IN never matches NULL, a
 * scoped sender never sees an unscoped (scopeId: null) campaign either,
 * mirroring assertMayActOnScope's own refusal of a null scope for anyone but
 * an unrestricted sender.
 */
export async function listCampaigns(personId: string) {
  const unrestricted = await can(personId, "outreach.send_unrestricted");
  if (unrestricted) {
    return prisma.emailCampaign.findMany({ orderBy: { createdAt: "desc" } });
  }
  const scopeIds = (await scopesForPerson(personId)).map((s) => s.id);
  return prisma.emailCampaign.findMany({
    where: { scopeId: { in: scopeIds } },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The scope predicate behind every campaign action, not only sending: viewing
 * a campaign, saving edits, cancelling, previewing its recipients, and
 * sending/scheduling it all gate on the SAME question -- may this person act
 * on a campaign bound to this scope? Named for what it checks, not for any one
 * caller, since "assertMaySendUnderScope" stopped fitting once callers besides
 * sending started reusing it (a department-scoped sender must not be able to
 * even open, edit, or cancel another department's campaign, let alone send
 * it). Re-checked on every call rather than cached, because a campaign can be
 * opened or scheduled under one permission/grant set and acted on again after
 * it has changed.
 *
 * A person needs outreach.send or outreach.send_unrestricted to act at all.
 * That base check is required even in the scoped branch below, because
 * AudienceScopeGrant is keyed by person/role with no reference to RBAC
 * permissions -- a scope grant alone proves nothing about send authority, and
 * this function must be correct standalone, not merely paired with a
 * permission check at the call site.
 *
 * outreach.send_unrestricted is strictly stronger and does not require
 * outreach.send: it also bypasses the scope-grant lookup and the requirement
 * to name a scope at all. A null scopeId is permitted only for an unrestricted
 * person, because for anyone else "no scope" would mean "no constraint", which
 * is a send-all (and by the same logic a view-all/edit-all/cancel-all).
 */
export async function assertMayActOnScope(
  personId: string,
  scopeId: string | null,
): Promise<AudienceScopeView | null> {
  const unrestricted = await can(personId, "outreach.send_unrestricted");
  const canSend = unrestricted || (await can(personId, "outreach.send"));
  if (!canSend) {
    throw new CampaignScopeError("You do not have permission to send campaigns.");
  }

  if (scopeId === null) {
    if (unrestricted) return null;
    throw new CampaignScopeError(
      "Select an audience scope. Only unrestricted senders may send without one.",
    );
  }

  const scope = await getScope(scopeId);
  if (!scope) throw new CampaignScopeError("That audience scope no longer exists.");
  if (unrestricted) return scope;

  const mine = await scopesForPerson(personId);
  if (!mine.some((s) => s.id === scopeId)) {
    throw new CampaignScopeError("You have not been granted that audience scope.");
  }
  return scope;
}

/** Why a recipient is in the roll. See ResolvedCampaignAudience.manualReasons. */
export type RecipientReason = "matched" | "included" | "pasted";

export type ResolvedCampaignAudience = {
  recipients: Recipient[];
  excludedNoEmail: number;
  /**
   * Why each MANUALLY added recipient is in the roll, keyed by person id. A
   * recipient absent from this map is a condition match.
   *
   * Every label is a TRUE statement of the same kind: it names a route that
   * ALONE would keep the person on the roll if the others were taken away. That
   * is what rules out the labels that would mislead, but it does not by itself
   * pick between two routes that both qualify, and two separate precedence
   * choices do that. They point different ways, so neither generalises to the
   * other and both are written down here rather than dressed up as one rule:
   *
   * 1. A condition match outranks BOTH manual routes. Someone who is both a
   *    match and an explicit include reads "matched", because the conditions
   *    hold them with the manual entry deleted, and because it is the route the
   *    sender never had to create. They never become a manual candidate at all
   *    (see the matchedIds filter below), so this one is structural rather than
   *    a check that could be forgotten.
   * 2. Between the two MANUAL routes, the one the sender can see and act on
   *    wins, which is the paste box. See the comment at the assignment.
   *
   * Applying 2 uniformly would label a condition-match-plus-pasted person
   * "pasted"; the code labels them "matched", and 1 is why.
   */
  manualReasons: Record<string, Exclude<RecipientReason, "matched">>;
  /** See unresolvedPastedAddresses. */
  unresolvedPasted: string[];
};

/**
 * Which pasted addresses this campaign will not email, echoed back so a typo is
 * visible instead of quietly shrinking the audience.
 *
 * SECURITY, and this is the whole reason the function is shaped this way: the
 * answer is computed by subtracting the FINAL recipient roll from what the
 * sender pasted, and by nothing else. It never asks whether a Person with a
 * given address exists, so it cannot answer that question. An address
 * belonging to a real person the campaign's scope excludes and an address
 * belonging to nobody at all produce the same OUTPUT: the same entry, in the
 * same list, with the same wording and the same count.
 *
 * Output is the word to be precise about, because it is not the only channel.
 * This function's shape guarantees nothing about what the code AROUND it does
 * with the same two cases, and the first version of that code gave the
 * difference away by doing measurably more work when the address matched a real
 * person -- see the comment on the hoisted scope resolve in
 * resolveCampaignAudience. Anything added to that path has to stay symmetric
 * too; matching output is necessary, not sufficient.
 *
 * Do not "improve" this by distinguishing them. Reporting "no such person"
 * separately from "outside your scope" hands a scoped sender an existence
 * oracle over the entire directory, one address at a time: paste an address,
 * read which message comes back, learn whether that person is in the database.
 * The send itself stays correct either way -- the roll is scope-filtered
 * upstream -- so what leaks is not who gets mail, it is who EXISTS, and that is
 * the leak. The UI wording (recipient-preview.tsx) carries the same rule.
 *
 * Two consequences are accepted deliberately, both because avoiding them would
 * mean looking a person up: an address belonging to someone the sender
 * explicitly excluded, and an address a send-once campaign has already mailed,
 * are both listed here too. In each case the address genuinely will not receive
 * this campaign, which is exactly what the list claims.
 */
function unresolvedPastedAddresses(pasted: string[], recipients: Recipient[]): string[] {
  const delivered = new Set(recipients.map((r) => r.email.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of pasted) {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    // Echoed with the sender's own casing so they can find it in the box they
    // pasted it into; deduped case-insensitively, the way the match itself is.
    if (!delivered.has(key)) out.push(trimmed);
  }
  return out;
}

/**
 * Resolve a campaign's recipients, honoring its scope, then layering on manual
 * include/exclude/pasted lists, then (if set) send-once dedup.
 *
 * A campaign naming a scope that has since vanished resolves to NOBODY. Falling
 * back to an unscoped resolve would turn a deleted boundary into a send-all,
 * which is exactly the failure this whole mechanism exists to prevent.
 *
 * Resolution order, a security requirement rather than a preference:
 *
 *   (matched union include union pasted) intersect scope minus exclude
 *
 * Manual additions are resolved AFTER the condition match but must pass
 * through the SAME scope check the conditions went through before they are
 * allowed to count -- see the comment at that intersection below. Exclusion is
 * applied last, so it wins over both the conditions and an explicit include.
 */
export async function resolveCampaignAudience(campaign: {
  id: string;
  audienceJson: unknown;
  scopeId: string | null;
  sendOncePerPerson: boolean;
  includePersonIds?: string[];
  excludePersonIds?: string[];
  pastedEmails?: string[];
}): Promise<ResolvedCampaignAudience> {
  const audience = campaign.audienceJson as Audience;

  const includePersonIds = campaign.includePersonIds ?? [];
  const excludePersonIds = campaign.excludePersonIds ?? [];
  const pastedEmails = campaign.pastedEmails ?? [];

  // Single exit point, so the pasted-address report is always computed from the
  // roll that is actually being returned -- after the scope, after the
  // excludes, after send-once dedup. A branch that returned early without it
  // would report an address as deliverable that this call had just dropped.
  const manualReasons: Record<string, Exclude<RecipientReason, "matched">> = {};
  const finish = (r: {
    recipients: Recipient[];
    excludedNoEmail: number;
  }): ResolvedCampaignAudience => ({
    ...r,
    manualReasons,
    unresolvedPasted: unresolvedPastedAddresses(pastedEmails, r.recipients),
  });

  let scope: AudienceScopeView | null = null;
  let resolved: { recipients: Recipient[]; excludedNoEmail: number };
  if (campaign.scopeId === null) {
    resolved = await resolveAudience(audience);
  } else {
    scope = await getScope(campaign.scopeId);
    if (!scope) return finish({ recipients: [], excludedNoEmail: 0 });
    resolved = await resolveAudience(audience, { scope: scope.audience });
  }

  if (includePersonIds.length > 0 || pastedEmails.length > 0) {
    // The scope is resolved HERE, before anything has looked at what the manual
    // lists resolved to, and unconditionally whenever there is a manual list at
    // all. That position is a security requirement, not a tidiness one.
    //
    // This resolve used to sit inside `if (candidateIds.length > 0)` below, and
    // candidateIds is non-empty iff a pasted address matched a Person row
    // ANYWHERE in the directory. So an address belonging to a real person
    // outside the scope cost a full extra resolveAudience of the whole scope
    // (its buildAudienceCtx reloads the compliance, HIPAA-expiry and clearance
    // maps when the scope names those fields, plus an unbounded findMany) while
    // an address belonging to nobody cost none of it. The two cases are
    // identical in everything the sender can READ, but a scoped sender who set
    // the campaign's conditions to something trivial could still tell them
    // apart by reloading the Audience tab and timing it -- the same existence
    // oracle, arriving over a side channel instead of the output.
    //
    // Note which half leaked: an include cannot, because a forged personId
    // makes candidateIds non-empty whether or not that person exists, so its
    // timing reveals only in-scope-ness, which is already inside the sender's
    // authority. Only the paste path turned on the existence of a row.
    let inScopeIds: Set<string> | null = null;
    if (scope) {
      const inScope = await resolveAudience(scope.audience);
      inScopeIds = new Set(inScope.recipients.map((r) => r.recordId));
    }

    // Resolve pasted addresses to Person ids case-insensitively, the same way
    // loadApplicantFacts (audience/resolve.ts) matches unlinked applicants back
    // to a Person: Prisma ignores `mode: "insensitive"` on `in` for Postgres,
    // so the comparison happens in memory rather than being pushed into the
    // query, which would silently match nothing.
    let pastedPersonIds: string[] = [];
    if (pastedEmails.length > 0) {
      const wanted = new Set(
        pastedEmails.map((e) => e.trim().toLowerCase()).filter((e) => e !== ""),
      );
      if (wanted.size > 0) {
        const candidates = await prisma.person.findMany({ select: { id: true, contactEmail: true } });
        pastedPersonIds = candidates
          .filter((p) => {
            const email = p.contactEmail?.trim().toLowerCase();
            return email ? wanted.has(email) : false;
          })
          .map((p) => p.id);
      }
    }

    // Anyone the CONDITIONS already matched is dropped from the manual
    // candidates here, which is also what decides their label: they keep the
    // "matched" reading (no entry in manualReasons) rather than being
    // relabelled by a redundant include or paste. See ResolvedCampaignAudience.
    const matchedIds = new Set(resolved.recipients.map((r) => r.recordId));
    const pastedSet = new Set(pastedPersonIds);
    const candidateIds = [...new Set([...includePersonIds, ...pastedPersonIds])].filter(
      (id) => !matchedIds.has(id),
    );

    // Manual additions go through the SAME scope filter the conditions went
    // through. Skipping that would let a pasted address reach anyone in the
    // database, which is the thing scopes exist to prevent.
    const admittedIds = inScopeIds
      ? candidateIds.filter((id) => inScopeIds.has(id))
      : candidateIds;

    if (admittedIds.length > 0) {
      const added = await prisma.person.findMany({
        where: { id: { in: admittedIds } },
        select: { id: true, name: true, contactEmail: true },
        // Same ordering resolveAudience gives the matched half. Without it the
        // manual block comes back in whatever order Postgres finds the rows,
        // so the preview (and the send order) would shuffle between calls for
        // no reason a sender could see.
        orderBy: { name: "asc" },
      });
      const addedRecipients: Recipient[] = [];
      let addedExcludedNoEmail = 0;
      for (const p of added) {
        const email = p.contactEmail?.trim() ?? "";
        if (email === "") {
          // KNOWN, and cosmetic: someone the CONDITIONS matched but who has no
          // address was already counted by resolveAudience above, and if they
          // are also on a manual list they are counted a second time here.
          // Reachable without forging anything on an unscoped campaign: add
          // someone by search, then have their contactEmail cleared later.
          // resolveAudience returns only a count, not the ids it dropped, so
          // deduplicating this means widening ResolvedAudience, which is a
          // change to a type the whole send path shares. Recorded rather than
          // done, because the only consequence is one number reading high.
          addedExcludedNoEmail++;
          continue;
        }
        // Between the two MANUAL routes, the label names the one the sender can
        // SEE and act on. Both admit them, so neither one's removal alone drops
        // them, and the paste box is the entry that is on screen: taking the
        // address out re-labels them "included", which is how the panel tells
        // them a second entry exists. The include list has no UI of its own.
        //
        // This tie-break is its own choice, not a consequence of the one that
        // makes "matched" win: that one prefers the route the sender never had
        // to create, and this one prefers the route they can act on. Both
        // labels are true either way (see ResolvedCampaignAudience). An earlier
        // version broke this tie towards "the more deliberate act", which was a
        // third principle again and would have made an include beat a condition
        // match too.
        manualReasons[p.id] = pastedSet.has(p.id) ? "pasted" : "included";
        addedRecipients.push({
          email,
          displayName: p.name,
          recordType: "PERSON",
          recordId: p.id,
          variables: personVariables({ name: p.name }),
        });
      }
      resolved = {
        recipients: [...resolved.recipients, ...addedRecipients],
        excludedNoEmail: resolved.excludedNoEmail + addedExcludedNoEmail,
      };
    }
  }

  if (excludePersonIds.length > 0) {
    // Applied last, over the union of matched + include + pasted, so an
    // exclude always wins even over an explicit include of the same person.
    const excludeSet = new Set(excludePersonIds);
    resolved = {
      recipients: resolved.recipients.filter((r) => !excludeSet.has(r.recordId)),
      excludedNoEmail: resolved.excludedNoEmail,
    };
  }

  if (!campaign.sendOncePerPerson) return finish(resolved);

  // Everyone who already received any run of this campaign. Matched on
  // personId, not email, so a person whose address changed between runs is
  // still recognised as already-mailed.
  const priorRuns = await prisma.emailCampaignRun.findMany({
    where: { campaignId: campaign.id },
    select: { id: true },
  });
  if (priorRuns.length === 0) return finish(resolved);

  const mailed = await prisma.emailLog.findMany({
    where: { campaignRunId: { in: priorRuns.map((r) => r.id) }, personId: { not: null } },
    select: { personId: true },
    distinct: ["personId"],
  });
  const already = new Set(mailed.map((m) => m.personId!));
  return finish({
    recipients: resolved.recipients.filter((r) => !already.has(r.recordId)),
    excludedNoEmail: resolved.excludedNoEmail,
  });
}

export async function updateCampaign(
  actorId: string | null,
  id: string,
  input: {
    name?: string;
    subject?: string;
    body?: string;
    audience: Audience;
    sendOncePerPerson?: boolean;
    /**
     * The sending identity the sender chose. Omit the key to leave the stored
     * choice alone; pass null or "" to clear it back to the resolution default.
     *
     * AUTHORIZED HERE, in the service, and not only in the server action that
     * calls it. The action is one caller; this function has to be correct
     * standalone, for the same reason assertMayActOnScope re-checks rather than
     * trusting its call site. A scoped sender submitting a hand-crafted
     * `fromEmail` in the compose form is exactly the request this refuses.
     */
    fromEmail?: string | null;
  },
) {
  const existing = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (existing.status !== "DRAFT") throw new CampaignValidationError(["Cannot edit a campaign that has been sent."]);

  if (!isAudience(input.audience)) {
    throw new CampaignValidationError(["Invalid audience"]);
  }

  const allowedVars = PERSON_VARIABLES.map((v) => v.name);
  const problems: string[] = [];

  const subject = input.subject ?? "";
  const body = input.body ?? "";

  const subjectResult = validateTemplate(subject, allowedVars);
  for (const u of subjectResult.unknownVariables) {
    problems.push(`Unknown variable in subject: ${u}`);
  }
  problems.push(...subjectResult.errors);

  const bodyResult = validateTemplate(body, allowedVars);
  for (const u of bodyResult.unknownVariables) {
    problems.push(`Unknown variable in body: ${u}`);
  }
  problems.push(...bodyResult.errors);

  if (problems.length > 0) {
    throw new CampaignValidationError(problems);
  }

  // The sending identity. Resolved against the CAMPAIGN's scope, not against any
  // scope the actor happens to hold: authorization is per campaign, so naming
  // another scope's admin-configured identity is refused exactly as an
  // unissued address is. resolveSenderIdentity throws SenderIdentityError,
  // which the caller renders alongside the template problems.
  const senderData: { fromEmail?: string | null; fromEmailSetById?: string | null } = {};
  if (input.fromEmail !== undefined) {
    // Normalized BEFORE the truthiness test, not after. A whitespace-only value
    // is truthy, and reading it as a choice would store whatever the resolution
    // default happens to be TODAY as an explicit pin, which then survives the
    // scope identity changing underneath it.
    const requested = normalizeSendingAddress(input.fromEmail);
    const scope = existing.scopeId ? await getScope(existing.scopeId) : null;
    const chosen = await resolveSenderIdentity(actorId, scope, requested);
    // A cleared choice drops the chooser with it, so a later re-check has no
    // stale claim to evaluate.
    senderData.fromEmail = requested ? (chosen?.address ?? null) : null;
    senderData.fromEmailSetById = senderData.fromEmail ? actorId : null;
  }

  return prisma.emailCampaign.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      subject,
      body,
      audienceJson: input.audience as object,
      ...(input.sendOncePerPerson !== undefined ? { sendOncePerPerson: input.sendOncePerPerson } : {}),
      ...senderData,
    },
  });
}

/**
 * The identities a person may choose from for this campaign, for the compose UI.
 *
 * Resolved against the campaign's OWN scope, which is the same scope
 * authorization runs against, so the menu and the check can never disagree.
 */
export async function senderIdentitiesForCampaign(
  personId: string,
  campaignId: string,
): Promise<SenderIdentityOption[]> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { scopeId: true },
  });
  const scope = campaign.scopeId ? await getScope(campaign.scopeId) : null;
  return availableSenderIdentities(personId, scope);
}

/**
 * The sender one run goes out as, re-resolved at enqueue time.
 *
 * Re-resolved rather than trusted for the same reason assertMayActOnScope
 * re-checks on every call: a recurring campaign is dispatched by cron, with no
 * actor, weeks after it was composed, and an identity revoked in between must
 * stop being used. A choice that no longer resolves falls back DOWN the order
 * (to the scope identity, then to the global default) rather than failing the
 * run, and the swap is logged here because this is the layer that knows which
 * campaign it was.
 */
async function senderForRun(campaign: {
  id: string;
  scopeId: string | null;
  fromEmail: string | null;
  fromEmailSetById: string | null;
}): Promise<{ fromEmail: string; fromName: string | null } | null> {
  const scope = campaign.scopeId ? await getScope(campaign.scopeId) : null;
  const { identity, honoredChoice } = await resolveCampaignSender(campaign, scope);
  if (!honoredChoice) {
    log.warn("[campaign] stored sending identity no longer resolves; falling back", {
      campaignId: campaign.id,
      requested: campaign.fromEmail,
      sendingAs: identity?.address ?? null,
    });
  }
  if (!identity) return null;
  return { fromEmail: identity.address, fromName: identity.displayName };
}

/**
 * How many recipients the preview lists by name. The count is always exact; this
 * caps only the visible roll, keeping the server-action payload bounded on an
 * audience of several thousand while still being long enough to actually scan.
 */
export const PREVIEW_SAMPLE_LIMIT = 200;

export type PreviewRecipient = {
  personId: string;
  name: string;
  email: string;
  /** Why they are in the roll. See ResolvedCampaignAudience.manualReasons. */
  reason: RecipientReason;
};

export type AudiencePreview = {
  count: number;
  excludedNoEmail: number;
  /** The first PREVIEW_SAMPLE_LIMIT recipients, in the send order. */
  sample: PreviewRecipient[];
  /** True when `count` exceeds what `sample` shows. */
  truncated: boolean;
  /**
   * Pasted addresses this campaign will not email. ONE list, with one wording,
   * whether the address belongs to nobody or to a real person outside the
   * campaign's scope -- see unresolvedPastedAddresses for why telling those two
   * apart would be an existence oracle over the whole directory.
   */
  unresolved: string[];
};

/**
 * How many people each clause of an UNSAVED audience tree matches, keyed by
 * node path ("root", "0", "1.2"), for the builder's live per-node counts.
 *
 * This is the only entry point in this service that takes an audience from the
 * caller instead of reading one out of the database, because its whole purpose
 * is to count the tree a sender is still editing. Two things follow, and both
 * are security properties rather than conveniences:
 *
 * 1. The scope is read from the campaign ROW below, never from the caller.
 *    Nothing in `audience` can influence which scope is applied, and there is
 *    deliberately no scope parameter for a caller to supply one -- the same
 *    split previewAction uses, where the bound scopeId gates PERMISSION and the
 *    campaign's own stored scopeId governs RESOLUTION.
 * 2. `audience` is unvalidated input and is put through the same `isAudience`
 *    gate updateCampaign applies before anything compiles it. The declared
 *    parameter type is erased at runtime and proves nothing about a value that
 *    arrived over a server-action boundary.
 *
 * A campaign whose scope has since been deleted counts NOBODY, by handing the
 * counter an EMPTY_AUDIENCE scope (which compiles to match-nobody). Falling
 * back to an unscoped count would turn a deleted boundary into a full-directory
 * readout, the same failure resolveCampaignAudience refuses for a real send.
 */
export async function countAudienceNodes(
  campaignId: string,
  audience: Audience,
): Promise<Record<string, number>> {
  // Depth BEFORE validity, because isAudience is itself recursive: a tree
  // nested deeply enough overflows the stack inside the validator that was
  // supposed to reject it, and again inside enumerateNodes, both of which run
  // before MAX_COUNTED_NODES gets a say. Iterative, so it cannot be its own
  // victim. See exceedsAudienceDepth.
  if (exceedsAudienceDepth(audience) || !isAudience(audience)) {
    throw new CampaignValidationError(["Invalid audience"]);
  }
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { scopeId: true },
  });
  if (campaign.scopeId === null) return countNodes(audience);
  const scope = await getScope(campaign.scopeId);
  return countNodes(audience, { scope: scope?.audience ?? EMPTY_AUDIENCE });
}

export async function previewAudience(id: string): Promise<AudiencePreview> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (!isAudience(campaign.audienceJson)) {
    throw new CampaignValidationError(["Stored audience is malformed"]);
  }
  const { recipients, excludedNoEmail, manualReasons, unresolvedPasted } =
    await resolveCampaignAudience(campaign);
  // Dedup by lowercased email exactly as the send path does, so the previewed
  // count matches what the confirm-count workflow will actually enqueue.
  const seen = new Set<string>();
  const deduped = recipients.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    count: deduped.length,
    excludedNoEmail,
    sample: deduped.slice(0, PREVIEW_SAMPLE_LIMIT).map((r) => ({
      personId: r.recordId,
      name: r.displayName,
      email: r.email,
      // Absent from the map means the conditions matched them; see the type.
      reason: manualReasons[r.recordId] ?? "matched",
    })),
    truncated: deduped.length > PREVIEW_SAMPLE_LIMIT,
    unresolved: unresolvedPasted,
  };
}

/**
 * People a sender may manually add to THIS campaign, matching a free-text query.
 *
 * The scope comes from the campaign ROW, read here exactly as countAudienceNodes
 * reads it, and there is deliberately no scope parameter for a caller to supply
 * one. That is the security property: a search over all people would let a
 * scoped sender enumerate the whole directory by typing letters, and learning
 * who EXISTS is the leak even though the send that follows is still
 * scope-filtered. The bound is applied one layer down, in searchPeople.
 *
 * A campaign whose scope has been deleted searches NOBODY (EMPTY_AUDIENCE
 * compiles to match-nobody), for the same reason its counts count nobody and
 * its send sends to nobody: falling back to an unscoped search would turn a
 * deleted boundary into a full-directory readout.
 */
export async function searchAudiencePeople(
  campaignId: string,
  query: string,
): Promise<PersonSearchHit[]> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { scopeId: true },
  });
  if (campaign.scopeId === null) return searchPeople(query);
  const scope = await getScope(campaign.scopeId);
  return searchPeople(query, { scope: scope?.audience ?? EMPTY_AUDIENCE });
}

/**
 * The most addresses one campaign's paste box may hold.
 *
 * Every one of them is compared against every Person row on each resolve, and
 * the whole array is echoed back into the editor, so an unbounded paste is a
 * cheap way to make every preview and every send of a campaign expensive.
 * Refused outright rather than silently truncated: a sender who pasted a
 * thousand addresses and got five hundred would have no way to tell.
 */
export const MAX_PASTED_EMAILS = 500;

/** One edit to a campaign's manual include / exclude / pasted lists. */
export type ManualListEdit =
  | { op: "include"; personId: string }
  | { op: "exclude"; personId: string }
  | { op: "clearExcluded" }
  | { op: "paste"; emails: string[] };

/**
 * Apply one edit to a campaign's manual lists.
 *
 * Read-modify-write in the service rather than in the action, so the array
 * arithmetic (dedupe, order, the case-insensitive paste normalisation) lives in
 * one place next to the resolver that consumes it.
 *
 * DRAFT-only, the same gate updateCampaign applies: once a campaign is sent or
 * scheduled its roll is decided, and editing the lists behind it would either
 * do nothing or silently change who a pending schedule mails.
 *
 * Storing a person id here is NOT a grant of anything. resolveCampaignAudience
 * re-filters every manual addition through the campaign's scope at resolve
 * time, so an id that never came from this campaign's own scoped search simply
 * resolves to nobody. The gate that decides who may edit is on the action; the
 * filter that decides who may be mailed is at resolution. Neither is this.
 */
export async function editManualLists(
  actorId: string | null,
  id: string,
  edit: ManualListEdit,
): Promise<void> {
  const existing = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (existing.status !== "DRAFT") {
    throw new CampaignValidationError(["Cannot edit a campaign that has been sent."]);
  }

  if (edit.op === "paste") {
    const seen = new Set<string>();
    const emails: string[] = [];
    for (const raw of edit.emails) {
      const trimmed = raw.trim();
      const key = trimmed.toLowerCase();
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      emails.push(trimmed);
    }
    if (emails.length > MAX_PASTED_EMAILS) {
      throw new CampaignValidationError([
        `That is ${emails.length} addresses. A campaign may hold at most ${MAX_PASTED_EMAILS}.`,
      ]);
    }
    await prisma.emailCampaign.update({ where: { id }, data: { pastedEmails: emails } });
    return;
  }

  if (edit.op === "clearExcluded") {
    await prisma.emailCampaign.update({ where: { id }, data: { excludePersonIds: [] } });
    return;
  }

  const column = edit.op === "include" ? "includePersonIds" : "excludePersonIds";
  const current = existing[column];
  if (current.includes(edit.personId)) return;
  await prisma.emailCampaign.update({
    where: { id },
    data: { [column]: [...current, edit.personId] },
  });
}

export async function testSend(actorId: string | null, id: string, toEmail: string) {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  const sampleCtx: Record<string, string> = {};
  for (const v of PERSON_VARIABLES) {
    sampleCtx[v.name] = v.sampleValue;
  }
  const { subject, html } = await renderInlineEmail(
    { subject: campaign.subject, body: campaign.body },
    sampleCtx,
  );
  // The test send goes out as the SAME identity the real run would use, resolved
  // through the same function. A test that arrived from a different address
  // would confirm nothing about the send it is standing in for -- in particular
  // it would not exercise the Send-As grant a yale.edu identity needs.
  await queueEmail(
    prisma,
    {
      to: toEmail,
      subject,
      html,
      template: "campaign:test",
      triggeredById: actorId,
    },
    { sender: await senderForRun(campaign) },
  );
  await recordAudit({
    actorPersonId: actorId,
    action: "campaign.test_send",
    entityType: "EmailCampaign",
    entityId: id,
    after: { to: toEmail },
  });
}

export async function executeRun(
  campaignId: string,
  opts: {
    actorId: string | null;
    // The precondition that makes the campaign eligible for THIS dispatch (e.g.
    // status DRAFT for "send now", status ACTIVE + nextRunAt due for a recurring
    // tick). Applied together with statusUpdate as a single conditional UPDATE so
    // overlapping passes can't both proceed -- see the claim inside the tx below.
    claimWhere: Prisma.EmailCampaignWhereInput;
    statusUpdate: Prisma.EmailCampaignUpdateManyMutationInput;
    recipients?: Recipient[];
  },
): Promise<{ runId: string; recipientCount: number }> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaignId } });

  if (campaign.subject.trim() === "") {
    throw new CampaignValidationError(["Campaign has no subject."]);
  }

  let deduped: Recipient[];
  if (opts.recipients) {
    deduped = opts.recipients;
  } else {
    if (!isAudience(campaign.audienceJson)) {
      throw new CampaignValidationError(["Stored audience is malformed"]);
    }
    const { recipients } = await resolveCampaignAudience(campaign);
    const seen = new Set<string>();
    deduped = recipients.filter((r) => {
      const key = r.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const layoutSource = await loadLayoutSource();
  // Resolve the brand color ONCE up front. renderInlineEmail otherwise reads
  // branding.brandColor per recipient; a large audience rendered via Promise.all
  // would then fire N concurrent setting.findUnique behind a small pool and time out
  // (P2024), throwing before the claim so nothing sends. Hoisting it (like
  // layoutSource) keeps the per-recipient render at zero DB round-trips.
  const brandColor = await getSetting<string>("branding.brandColor");

  // Resolved once for the whole run, and BEFORE the claim: every recipient of one
  // run must come from the same address, and re-resolving here (rather than
  // trusting the stored choice) is what makes a revocation between Save and Send
  // take effect. Null means no campaign identity resolved, and the enqueue falls
  // through to the per-template sender rules exactly as it did before Phase 3.
  const runSender = await senderForRun(campaign);

  // Render every recipient BEFORE opening the claim transaction. With layoutSource
  // and brandColor hoisted, renderInlineEmail is pure CPU (no DB round-trips), so
  // doing it up front keeps the transaction short and independent of recipient count.
  const rendered = await Promise.all(
    deduped.map(async (recipient) => {
      const { subject, html } = await renderInlineEmail(
        { subject: campaign.subject, body: campaign.body },
        recipient.variables,
        layoutSource,
        brandColor,
      );
      return { to: recipient.email, subject, html, personId: recipient.recordId };
    }),
  );

  const runId = await prisma.$transaction(async (tx) => {
    // Guard against double-dispatch with an atomic claim: apply the status
    // transition up front as a conditional updateMany gated on claimWhere. This
    // compiles to a single `UPDATE ... WHERE`, and Postgres serializes
    // concurrent writers on the row -- so of two overlapping passes (lapping
    // cron ticks, or a "send now" racing the per-minute drainer) the first
    // commits the transition and the second re-evaluates claimWhere against the
    // updated row, matches zero rows, and aborts here.
    //
    // The per-recipient enqueue is deliberately OUTSIDE this transaction (below).
    // Enqueuing hundreds of rows inside one interactive tx exceeded the ~5s
    // timeout and rolled the whole thing back, including the claim -- so a large
    // SCHEDULED/RECURRING campaign re-dispatched and failed identically every cron
    // tick forever (audit F1). Keeping only the claim + run row here bounds the tx
    // to two writes.
    const claimed = await tx.emailCampaign.updateMany({
      where: { id: campaignId, ...opts.claimWhere },
      data: opts.statusUpdate,
    });
    if (claimed.count !== 1) {
      throw new CampaignAlreadyDispatchedError();
    }

    const run = await tx.emailCampaignRun.create({ data: { campaignId, recipientCount: deduped.length } });
    return run.id;
  });

  // The claim has committed (campaign marked sent), so enqueue the recipients now
  // in chunked createMany batches. Trade-off: a crash between the claim commit and
  // here can leave a marked-sent campaign with un-enqueued recipients -- rare, and
  // far preferable to the previous fail-forever behavior.
  await queueEmails(
    prisma,
    "campaign",
    rendered.map((r) => ({ ...r, triggeredById: opts.actorId, campaignRunId: runId })),
    { sender: runSender },
  );

  await recordAudit({
    actorPersonId: opts.actorId, action: "campaign.send",
    entityType: "EmailCampaign", entityId: campaignId,
    after: { recipientCount: deduped.length, runId },
  });
  return { runId, recipientCount: deduped.length };
}

export async function sendCampaignNow(
  actorId: string | null,
  id: string,
  opts: { confirmCount?: number },
): Promise<{ runId: string; recipientCount: number }> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (campaign.status !== "DRAFT") throw new CampaignValidationError(["This campaign was already sent."]);
  if (campaign.subject.trim() === "") throw new CampaignValidationError(["Add a subject before sending."]);
  if (!isAudience(campaign.audienceJson)) throw new CampaignValidationError(["Stored audience is malformed"]);

  const { recipients } = await resolveCampaignAudience(campaign);
  const seen = new Set<string>();
  const deduped = recipients.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // A send to nobody would flip the campaign to terminal SENT with zero recipients
  // -- unrecoverable and almost always a forgotten condition. Block it up front.
  if (deduped.length === 0) {
    throw new CampaignValidationError([
      "This audience matches nobody. Add or adjust a condition before sending.",
    ]);
  }
  if (deduped.length > CAMPAIGN_CONFIRM_THRESHOLD && opts.confirmCount !== deduped.length) {
    throw new CampaignConfirmationError(deduped.length);
  }
  return executeRun(id, {
    actorId,
    claimWhere: { status: "DRAFT" },
    statusUpdate: { status: "SENT" },
    recipients: deduped,
  });
}

export type ScheduleInput =
  | { scheduleType: "SCHEDULED"; scheduledAt?: Date }
  | { scheduleType: "RECURRING"; cronExpr?: string };

export async function scheduleCampaign(
  actorId: string | null,
  id: string,
  input: ScheduleInput,
  now: Date = new Date(),
  opts: { confirmCount?: number } = {},
): Promise<void> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (campaign.status !== "DRAFT") throw new CampaignValidationError(["Only a draft can be scheduled."]);
  if (campaign.subject.trim() === "") throw new CampaignValidationError(["Add a subject before sending."]);
  if (!isAudience(campaign.audienceJson)) throw new CampaignValidationError(["Stored audience is malformed"]);

  // Same large-audience safeguard sendCampaignNow enforces: resolve + dedup the
  // audience and require the admin to confirm the count before scheduling a blast.
  // For a recurring campaign this is the count as of now (the audience resolves
  // live at each run), which is still the right order-of-magnitude check against
  // an accidental send-all.
  const { recipients } = await resolveCampaignAudience(campaign);
  const seen = new Set<string>();
  const deduped = recipients.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length > CAMPAIGN_CONFIRM_THRESHOLD && opts.confirmCount !== deduped.length) {
    throw new CampaignConfirmationError(deduped.length);
  }
  // A one-off SCHEDULED send to nobody is the same unrecoverable mistake as an
  // immediate send-to-nobody. A RECURRING campaign is exempt: its audience is
  // resolved live at each run, so zero-as-of-now is legitimate (e.g. "certs
  // expiring this week").
  if (input.scheduleType === "SCHEDULED" && deduped.length === 0) {
    throw new CampaignValidationError([
      "This audience matches nobody. Add or adjust a condition before scheduling a send.",
    ]);
  }

  if (input.scheduleType === "SCHEDULED") {
    if (!input.scheduledAt) throw new CampaignValidationError(["A send time is required"]);
    // A past send time is NOT a scheduled send: dispatchDueCampaigns selects on
    // `nextRunAt <= now`, so anything backdated is already due and goes out on the
    // very next 30-minute tick, with no warning and nothing to cancel. That is how
    // a campaign meant for 8am tomorrow left with one meant for 6:30pm tonight --
    // the date was a day behind, so it had been "due" for ten hours.
    //
    // Refused rather than clamped to now, for the same reason the zero-recipient
    // case above is refused: an unintended blast cannot be recalled, so the only
    // safe reading of an impossible time is that the admin mistyped it.
    if (input.scheduledAt.getTime() <= now.getTime()) {
      throw new CampaignValidationError([
        "That send time has already passed. Pick a time in the future, and check the date as well as the time.",
      ]);
    }
    await prisma.emailCampaign.update({
      where: { id },
      data: { scheduleType: "SCHEDULED", scheduledAt: input.scheduledAt, cronExpr: null, nextRunAt: input.scheduledAt, status: "SCHEDULED" },
    });
  } else {
    if (!input.cronExpr || !isValidCron(input.cronExpr)) {
      throw new CampaignValidationError(["A valid cron expression is required"]);
    }
    // Reject a cadence finer than the dispatcher can honor; such occurrences would
    // be silently skipped between the 30-minute dispatch ticks.
    if (cronMinIntervalMinutes(input.cronExpr, now) < CAMPAIGN_DISPATCH_CADENCE_MINUTES) {
      throw new CampaignValidationError([
        `Recurring sends run at most every ${CAMPAIGN_DISPATCH_CADENCE_MINUTES} minutes. Choose a coarser schedule (e.g. daily or weekly).`,
      ]);
    }
    await prisma.emailCampaign.update({
      where: { id },
      data: { scheduleType: "RECURRING", cronExpr: input.cronExpr, scheduledAt: null, nextRunAt: nextCronAfter(input.cronExpr, now), status: "ACTIVE" },
    });
  }
  await recordAudit({ actorPersonId: actorId, action: "campaign.schedule", entityType: "EmailCampaign", entityId: id, after: { scheduleType: input.scheduleType, recipientCount: deduped.length } });
}

export async function cancelCampaign(actorId: string | null, id: string): Promise<void> {
  // Atomic claim, matching executeRun's dispatch guard: read-then-update let a
  // cancel land AFTER dispatchDueCampaigns had already claimed and sent the
  // campaign, reporting success for a send that went out. The precondition also
  // covers wrong-status and not-found in one shot.
  const { count } = await prisma.emailCampaign.updateMany({
    where: { id, status: { in: ["SCHEDULED", "ACTIVE"] } },
    data: { status: "CANCELLED", nextRunAt: null },
  });
  if (count === 0) {
    throw new CampaignValidationError(["This campaign can no longer be cancelled (it may already have been dispatched)."]);
  }
  await recordAudit({ actorPersonId: actorId, action: "campaign.cancel", entityType: "EmailCampaign", entityId: id });
}
