import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { validateTemplate } from "@/platform/email/render/validate";
import { isAudience } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { resolveAudience } from "@/platform/email/audience/resolve";
import { renderInlineEmail, loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { queueEmail } from "@/platform/email/send";

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
  return prisma.emailCampaign.findUnique({ where: { id } });
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

export async function sendCampaignNow(
  actorId: string | null,
  id: string,
  opts: { confirmCount?: number },
): Promise<{ runId: string; recipientCount: number }> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });

  if (campaign.status !== "DRAFT") {
    throw new Error("Campaign already sent");
  }

  if (!isAudience(campaign.audienceJson)) {
    throw new CampaignValidationError(["Stored audience is malformed"]);
  }
  const audience = campaign.audienceJson;
  const { recipients } = await resolveAudience(audience);

  // Deduplicate by lowercased email (keep first)
  const seen = new Set<string>();
  const deduped = recipients.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (
    deduped.length > CAMPAIGN_CONFIRM_THRESHOLD &&
    opts.confirmCount !== deduped.length
  ) {
    throw new CampaignConfirmationError(deduped.length);
  }

  const layoutSource = await loadLayoutSource();

  const runId = await prisma.$transaction(async (tx) => {
    const run = await tx.emailCampaignRun.create({
      data: {
        campaignId: id,
        recipientCount: deduped.length,
      },
    });

    for (const recipient of deduped) {
      const { subject, html } = await renderInlineEmail(
        { subject: campaign.subject, body: campaign.body },
        recipient.variables,
        layoutSource,
      );
      await queueEmail(tx, {
        to: recipient.email,
        subject,
        html,
        template: "campaign",
        personId: recipient.recordId,
        triggeredById: actorId,
        campaignRunId: run.id,
      });
    }

    await tx.emailCampaign.update({
      where: { id },
      data: { status: "SENT" },
    });

    return run.id;
  });

  await recordAudit({
    actorPersonId: actorId,
    action: "campaign.send",
    entityType: "EmailCampaign",
    entityId: id,
    after: { recipientCount: deduped.length, runId },
  });

  return { runId, recipientCount: deduped.length };
}
