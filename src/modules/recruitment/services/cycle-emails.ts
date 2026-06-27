import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { getDescriptor } from "@/platform/email/templates/registry";
import { loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { validateTemplate } from "@/platform/email/render/validate";
import type { VariableDef } from "@/platform/email/templates/types";
import { CYCLE_EMAIL_KEYS, type CycleEmailKey, resolveCycleEmail } from "../email/render";

export class CycleEmailValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid template: ${problems.join("; ")}`);
    this.name = "CycleEmailValidationError";
  }
}
export class CycleEmailAuthError extends Error {
  constructor(message = "You do not have permission to edit cycle emails.") {
    super(message);
    this.name = "CycleEmailAuthError";
  }
}

export type CycleEmailSummary = { key: CycleEmailKey; name: string; hasOverride: boolean };
export type CycleEmailForEdit = {
  key: CycleEmailKey;
  name: string;
  variables: VariableDef[];
  subject: string;
  body: string;
  hasOverride: boolean;
  layoutSource: string;
};

function descriptorOrThrow(key: CycleEmailKey) {
  const d = getDescriptor(key);
  if (!d) throw new Error(`Unknown email template: ${key}`);
  return d;
}

function validateOrThrow(key: CycleEmailKey, subject: string, body: string): void {
  const allowed = descriptorOrThrow(key).variables.map((v) => v.name);
  const s = validateTemplate(subject, allowed);
  const b = validateTemplate(body, allowed);
  const problems = [
    ...s.errors,
    ...b.errors,
    ...s.unknownVariables.map((v) => `Unknown variable in subject: ${v}`),
    ...b.unknownVariables.map((v) => `Unknown variable in body: ${v}`),
  ];
  if (problems.length > 0) throw new CycleEmailValidationError(problems);
}

export async function listCycleEmails(cycleId: string): Promise<CycleEmailSummary[]> {
  const overrides = await prisma.recruitmentCycleEmail.findMany({ where: { cycleId }, select: { key: true } });
  const overridden = new Set(overrides.map((o) => o.key));
  return CYCLE_EMAIL_KEYS.map((key) => ({ key, name: descriptorOrThrow(key).name, hasOverride: overridden.has(key) }));
}

export async function getCycleEmailForEdit(cycleId: string, key: CycleEmailKey): Promise<CycleEmailForEdit> {
  const d = descriptorOrThrow(key);
  const [override, sources] = await Promise.all([
    prisma.recruitmentCycleEmail.findUnique({ where: { cycleId_key: { cycleId, key } } }),
    resolveCycleEmail(cycleId, key),
  ]);
  return {
    key,
    name: d.name,
    variables: d.variables,
    subject: sources.subjectSource,
    body: sources.bodySource,
    hasOverride: override !== null,
    layoutSource: await loadLayoutSource(),
  };
}

export async function saveCycleEmail(
  cycleId: string,
  key: CycleEmailKey,
  input: { subject: string; body: string },
  actorId: string,
): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) throw new CycleEmailAuthError();
  validateOrThrow(key, input.subject, input.body);
  const before = await prisma.recruitmentCycleEmail.findUnique({ where: { cycleId_key: { cycleId, key } } });
  await prisma.recruitmentCycleEmail.upsert({
    where: { cycleId_key: { cycleId, key } },
    create: { cycleId, key, subject: input.subject, body: input.body, updatedById: actorId },
    update: { subject: input.subject, body: input.body, updatedById: actorId },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.cycle_email_save",
    entityType: "RecruitmentCycleEmail",
    entityId: `${cycleId}:${key}`,
    before: before ? { subject: before.subject, body: before.body } : undefined,
    after: { subject: input.subject, body: input.body },
  });
}

export async function resetCycleEmail(cycleId: string, key: CycleEmailKey, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) throw new CycleEmailAuthError();
  const before = await prisma.recruitmentCycleEmail.findUnique({ where: { cycleId_key: { cycleId, key } } });
  if (!before) return;
  await prisma.recruitmentCycleEmail.delete({ where: { cycleId_key: { cycleId, key } } });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.cycle_email_reset",
    entityType: "RecruitmentCycleEmail",
    entityId: `${cycleId}:${key}`,
    before: { subject: before.subject, body: before.body },
  });
}
