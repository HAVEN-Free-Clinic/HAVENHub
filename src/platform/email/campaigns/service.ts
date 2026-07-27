import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { validateTemplate } from "@/platform/email/render/validate";
import { isAudience } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { resolveAudience } from "@/platform/email/audience/resolve";
import type { Recipient } from "@/platform/email/audience/resolve";
import { renderInlineEmail, loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { queueEmail, queueEmails } from "@/platform/email/send";
import type { Prisma } from "@prisma/client";
import { isValidCron, nextCronAfter, cronMinIntervalMinutes, CAMPAIGN_DISPATCH_CADENCE_MINUTES } from "./cron";
import { getStarter } from "./starters";

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

export async function createDraft(
  actorId: string | null,
  name: string,
  opts: { starterId?: string } = {},
) {
  // A starter seeds the draft's subject + body (and supplies a default name when the
  // creator left it blank). An unknown / omitted starter falls back to an empty draft.
  const starter = opts.starterId ? getStarter(opts.starterId) : undefined;
  return prisma.emailCampaign.create({
    data: {
      name: name || starter?.name || "Untitled campaign",
      createdById: actorId,
      status: "DRAFT",
      audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] },
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

export async function listCampaigns() {
  return prisma.emailCampaign.findMany({ orderBy: { createdAt: "desc" } });
}

export async function updateCampaign(
  actorId: string | null,
  id: string,
  input: { name?: string; subject?: string; body?: string; audience: Audience },
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
    },
  });
}

export async function previewAudience(id: string) {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (!isAudience(campaign.audienceJson)) {
    throw new CampaignValidationError(["Stored audience is malformed"]);
  }
  const audience = campaign.audienceJson;
  const { recipients, excludedNoEmail } = await resolveAudience(audience);
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
    sample: deduped.slice(0, 20),
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
    const { recipients } = await resolveAudience(campaign.audienceJson);
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

  const { recipients } = await resolveAudience(campaign.audienceJson);
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
  const { recipients } = await resolveAudience(campaign.audienceJson);
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
