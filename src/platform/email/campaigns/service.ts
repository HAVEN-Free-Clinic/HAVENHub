import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { validateTemplate } from "@/platform/email/render/validate";
import { isAudience, EMPTY_AUDIENCE } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { PERSON_VARIABLES, personVariables } from "@/platform/email/audience/variables";
import { resolveAudience } from "@/platform/email/audience/resolve";
import type { Recipient } from "@/platform/email/audience/resolve";
import { renderInlineEmail, loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { queueEmail, queueEmails } from "@/platform/email/send";
import type { Prisma } from "@prisma/client";
import { isValidCron, nextCronAfter, cronMinIntervalMinutes, CAMPAIGN_DISPATCH_CADENCE_MINUTES } from "./cron";
import { getStarter } from "./starters";
import { can } from "@/platform/rbac/engine";
import { getScope, scopesForPerson } from "@/platform/email/audience/scopes";
import type { AudienceScopeView } from "@/platform/email/audience/scopes";

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
}): Promise<{ recipients: Recipient[]; excludedNoEmail: number }> {
  const audience = campaign.audienceJson as Audience;

  let scope: AudienceScopeView | null = null;
  let resolved: { recipients: Recipient[]; excludedNoEmail: number };
  if (campaign.scopeId === null) {
    resolved = await resolveAudience(audience);
  } else {
    scope = await getScope(campaign.scopeId);
    if (!scope) return { recipients: [], excludedNoEmail: 0 };
    resolved = await resolveAudience(audience, { scope: scope.audience });
  }

  const includePersonIds = campaign.includePersonIds ?? [];
  const excludePersonIds = campaign.excludePersonIds ?? [];
  const pastedEmails = campaign.pastedEmails ?? [];

  if (includePersonIds.length > 0 || pastedEmails.length > 0) {
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

    const matchedIds = new Set(resolved.recipients.map((r) => r.recordId));
    const candidateIds = [...new Set([...includePersonIds, ...pastedPersonIds])].filter(
      (id) => !matchedIds.has(id),
    );

    if (candidateIds.length > 0) {
      // Manual additions go through the SAME scope filter the conditions went
      // through. Skipping that would let a pasted address reach anyone in the
      // database, which is the thing scopes exist to prevent.
      let admittedIds = candidateIds;
      if (scope) {
        const inScope = await resolveAudience(scope.audience);
        const inScopeIds = new Set(inScope.recipients.map((r) => r.recordId));
        admittedIds = candidateIds.filter((id) => inScopeIds.has(id));
      }

      if (admittedIds.length > 0) {
        const added = await prisma.person.findMany({
          where: { id: { in: admittedIds } },
          select: { id: true, name: true, contactEmail: true },
        });
        const addedRecipients: Recipient[] = [];
        let addedExcludedNoEmail = 0;
        for (const p of added) {
          const email = p.contactEmail?.trim() ?? "";
          if (email === "") { addedExcludedNoEmail++; continue; }
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

  if (!campaign.sendOncePerPerson) return resolved;

  // Everyone who already received any run of this campaign. Matched on
  // personId, not email, so a person whose address changed between runs is
  // still recognised as already-mailed.
  const priorRuns = await prisma.emailCampaignRun.findMany({
    where: { campaignId: campaign.id },
    select: { id: true },
  });
  if (priorRuns.length === 0) return resolved;

  const mailed = await prisma.emailLog.findMany({
    where: { campaignRunId: { in: priorRuns.map((r) => r.id) }, personId: { not: null } },
    select: { personId: true },
    distinct: ["personId"],
  });
  const already = new Set(mailed.map((m) => m.personId!));
  return {
    recipients: resolved.recipients.filter((r) => !already.has(r.recordId)),
    excludedNoEmail: resolved.excludedNoEmail,
  };
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

  return prisma.emailCampaign.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      subject,
      body,
      audienceJson: input.audience as object,
      ...(input.sendOncePerPerson !== undefined ? { sendOncePerPerson: input.sendOncePerPerson } : {}),
    },
  });
}

/**
 * How many recipients the preview lists by name. The count is always exact; this
 * caps only the visible roll, keeping the server-action payload bounded on an
 * audience of several thousand while still being long enough to actually scan.
 */
export const PREVIEW_SAMPLE_LIMIT = 200;

export type AudiencePreview = {
  count: number;
  excludedNoEmail: number;
  /** The first PREVIEW_SAMPLE_LIMIT recipients, in the send order (name asc). */
  sample: { name: string; email: string }[];
  /** True when `count` exceeds what `sample` shows. */
  truncated: boolean;
};

export async function previewAudience(id: string): Promise<AudiencePreview> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (!isAudience(campaign.audienceJson)) {
    throw new CampaignValidationError(["Stored audience is malformed"]);
  }
  const { recipients, excludedNoEmail } = await resolveCampaignAudience(campaign);
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
      name: r.displayName,
      email: r.email,
    })),
    truncated: deduped.length > PREVIEW_SAMPLE_LIMIT,
  };
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
  await queueEmail(prisma, {
    to: toEmail,
    subject,
    html,
    template: "campaign:test",
    triggeredById: actorId,
  });
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
