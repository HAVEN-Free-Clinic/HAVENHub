import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { validateTemplate } from "@/platform/email/render/validate";
import { isAudience } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { resolveAudience } from "@/platform/email/audience/resolve";
import type { Recipient } from "@/platform/email/audience/resolve";
import { renderInlineEmail, loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { queueEmail } from "@/platform/email/send";
import type { Prisma } from "@prisma/client";
import { isValidCron, nextCronAfter } from "./cron";

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

export async function createDraft(actorId: string | null, name: string) {
  return prisma.emailCampaign.create({
    data: {
      name,
      createdById: actorId,
      status: "DRAFT",
      audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] },
      subject: "",
      body: "",
    },
  });
}

export async function getCampaign(id: string) {
  return prisma.emailCampaign.findUnique({ where: { id }, include: { runs: { orderBy: { runAt: "desc" } } } });
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
  if (existing.status !== "DRAFT") throw new Error("Cannot edit a campaign that has been sent");

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
  return {
    count: recipients.length,
    excludedNoEmail,
    sample: recipients.slice(0, 20),
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
  opts: { actorId: string | null; statusUpdate: Prisma.EmailCampaignUpdateInput; recipients?: Recipient[] },
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

  const runId = await prisma.$transaction(async (tx) => {
    // Guard against double-dispatch: re-read inside the transaction so two
    // concurrent dispatch attempts -- overlapping cron ticks, or a manual
    // "send now" racing the per-minute drainer -- can't both proceed past this
    // point. The status flip below commits atomically with the run.
    const current = await tx.emailCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (current.status === "SENT" || current.status === "CANCELLED") {
      throw new Error("Campaign already dispatched");
    }

    const run = await tx.emailCampaignRun.create({ data: { campaignId, recipientCount: deduped.length } });
    for (const recipient of deduped) {
      const { subject, html } = await renderInlineEmail(
        { subject: campaign.subject, body: campaign.body },
        recipient.variables,
        layoutSource,
      );
      await queueEmail(tx, {
        to: recipient.email, subject, html, template: "campaign",
        personId: recipient.recordId, triggeredById: opts.actorId, campaignRunId: run.id,
      });
    }
    await tx.emailCampaign.update({ where: { id: campaignId }, data: opts.statusUpdate });
    return run.id;
  });

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
  if (campaign.status !== "DRAFT") throw new Error("Campaign already sent");
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

  if (deduped.length > CAMPAIGN_CONFIRM_THRESHOLD && opts.confirmCount !== deduped.length) {
    throw new CampaignConfirmationError(deduped.length);
  }
  return executeRun(id, { actorId, statusUpdate: { status: "SENT" }, recipients: deduped });
}

export type ScheduleInput =
  | { scheduleType: "SCHEDULED"; scheduledAt?: Date }
  | { scheduleType: "RECURRING"; cronExpr?: string };

export async function scheduleCampaign(
  actorId: string | null,
  id: string,
  input: ScheduleInput,
  now: Date = new Date(),
): Promise<void> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (campaign.status !== "DRAFT") throw new Error("Only a draft can be scheduled");
  if (campaign.subject.trim() === "") throw new CampaignValidationError(["Add a subject before sending."]);

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
    await prisma.emailCampaign.update({
      where: { id },
      data: { scheduleType: "RECURRING", cronExpr: input.cronExpr, scheduledAt: null, nextRunAt: nextCronAfter(input.cronExpr, now), status: "ACTIVE" },
    });
  }
  await recordAudit({ actorPersonId: actorId, action: "campaign.schedule", entityType: "EmailCampaign", entityId: id, after: { scheduleType: input.scheduleType } });
}

export async function cancelCampaign(actorId: string | null, id: string): Promise<void> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (campaign.status !== "SCHEDULED" && campaign.status !== "ACTIVE") {
    throw new Error("Only a scheduled or recurring campaign can be cancelled");
  }
  await prisma.emailCampaign.update({ where: { id }, data: { status: "CANCELLED", nextRunAt: null } });
  await recordAudit({ actorPersonId: actorId, action: "campaign.cancel", entityType: "EmailCampaign", entityId: id });
}
