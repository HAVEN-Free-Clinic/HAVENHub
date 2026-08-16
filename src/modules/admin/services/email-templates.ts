import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { getDescriptor, listDescriptors, LAYOUT_KEY } from "@/platform/email/templates/registry";
import type { TemplateDescriptor } from "@/platform/email/templates/types";
import { validateTemplate } from "@/platform/email/render/validate";
import { tokenize } from "@/platform/email/render/tokens";
import {
  resolveInheritedSender,
  listSenderRules,
  type ResolvedSender,
} from "@/platform/email/sender-rules";
import { getSetting } from "@/platform/settings/service";

export class TemplateValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid template: ${problems.join("; ")}`);
    this.name = "TemplateValidationError";
  }
}

function allowedVars(d: TemplateDescriptor): string[] {
  return d.variables.map((v) => v.name);
}

export type TemplateForEdit = {
  key: string;
  name: string;
  category: TemplateDescriptor["category"];
  variables: TemplateDescriptor["variables"];
  defaultSubject: string;
  defaultBody: string;
  subject: string;
  body: string;
  hasOverride: boolean;
  /** True when the template being edited is the shared layout wrapper itself. */
  isLayout: boolean;
  /**
   * The effective layout body (override or code default). The editor uses this to
   * render a full-email preview: it injects the template body into this layout's
   * `{{{ body }}}` slot. When `isLayout` is true the editor previews its own body
   * directly instead of wrapping.
   */
  layoutSource: string;
  /** TEMPLATE-scope sender override for this key, or null when inheriting. */
  senderFromEmail: string | null;
  senderFromName: string | null;
  /** What a blank override inherits (category rule or global default), for the placeholder. */
  inheritedSender: ResolvedSender;
  hasSenderOverride: boolean;
  /**
   * Resolved `branding.brandColor`, injected into the preview's layout context so
   * the preview header band + links match the live `{{ brandColor }}` render.
   */
  brandColor: string;
};

export async function getTemplateForEdit(key: string): Promise<TemplateForEdit> {
  const d = getDescriptor(key);
  if (!d) throw new Error(`Unknown email template: ${key}`);
  const layout = getDescriptor(LAYOUT_KEY);
  if (!layout) throw new Error("Missing layout template");

  const isLayout = key === LAYOUT_KEY;
  const keysToLoad = isLayout ? [key] : [key, LAYOUT_KEY];
  const overrides = await prisma.emailTemplate.findMany({ where: { key: { in: keysToLoad } } });
  const byKey = new Map(overrides.map((o) => [o.key, o]));
  const override = byKey.get(key) ?? null;
  const layoutSource = byKey.get(LAYOUT_KEY)?.body ?? layout.defaultBody;
  const brandColor = await getSetting<string>("branding.brandColor");

  const senderRules = await listSenderRules();
  const templateRule = senderRules.find((r) => r.scope === "TEMPLATE" && r.target === key) ?? null;
  const inheritedSender = await resolveInheritedSender(key);

  return {
    key: d.key,
    name: d.name,
    category: d.category,
    variables: d.variables,
    defaultSubject: d.defaultSubject,
    defaultBody: d.defaultBody,
    subject: override?.subject ?? d.defaultSubject,
    body: override?.body ?? d.defaultBody,
    hasOverride: override !== null,
    isLayout,
    layoutSource,
    senderFromEmail: templateRule?.fromEmail ?? null,
    senderFromName: templateRule?.fromName ?? null,
    inheritedSender,
    hasSenderOverride: templateRule !== null,
    brandColor,
  };
}

/**
 * The layout is the single wrapper EVERY platform email renders inside, and it
 * reaches the content through one raw slot: `{{{ body }}}`.
 *
 * Nothing used to require that slot to survive an edit, and both ways of losing
 * it passed validation, because `body` IS a declared layout variable:
 *
 *   - `{{ body }}` (double brace) takes the renderer's `var` branch and emits
 *     `esc(String(v))`, so every email is delivered as visible escaped HTML
 *     source;
 *   - omitting it altogether produces a header band, a footer, and no content.
 *
 * The editor makes the first one easy to reach by accident: its "Insert a
 * variable" chips are built from the descriptor's variables and insert
 * `{{ name }}` for all of them, including `body` (audit 14, EMAIL-6).
 *
 * One admin action, every outbound email, no send-time error.
 */
function layoutSlotProblems(key: string, body: string): string[] {
  if (key !== LAYOUT_KEY) return [];
  const tokens = tokenize(body);
  if (tokens.some((t) => t.type === "rawVar" && t.name === "body")) return [];
  if (tokens.some((t) => t.type === "var" && t.name === "body")) {
    return [
      "The layout's {{ body }} must be triple-braced as {{{ body }}}. Double braces escape the HTML, so every email would be delivered as visible markup.",
    ];
  }
  return [
    "The layout must contain the {{{ body }}} slot. Without it every email renders with a header and footer and no content.",
  ];
}

function validateOrThrow(
  d: TemplateDescriptor,
  subject: string,
  body: string,
  key?: string,
): void {
  const allowed = allowedVars(d);
  const s = validateTemplate(subject, allowed);
  const b = validateTemplate(body, allowed);
  const problems = [
    // renderEmail only falls back to the descriptor's default subject on
    // null/undefined, so a blank override subject would send verbatim (empty
    // Subject). Reject it on save, matching the campaign send path.
    ...(subject.trim() === "" ? ["Subject cannot be empty."] : []),
    ...s.errors,
    ...b.errors,
    ...s.unknownVariables.map((v) => `Unknown variable in subject: ${v}`),
    ...b.unknownVariables.map((v) => `Unknown variable in body: ${v}`),
    ...(key ? layoutSlotProblems(key, body) : []),
  ];
  if (problems.length > 0) throw new TemplateValidationError(problems);
}

export async function saveTemplateOverride(
  actorPersonId: string | null,
  key: string,
  input: { subject: string; body: string },
): Promise<void> {
  const d = getDescriptor(key);
  if (!d) throw new Error(`Unknown email template: ${key}`);
  validateOrThrow(d, input.subject, input.body, key);

  const before = await prisma.emailTemplate.findUnique({ where: { key } });
  await prisma.emailTemplate.upsert({
    where: { key },
    create: { key, subject: input.subject, body: input.body, updatedById: actorPersonId },
    update: { subject: input.subject, body: input.body, updatedById: actorPersonId },
  });
  await recordAudit({
    actorPersonId,
    action: "email.template_save",
    entityType: "EmailTemplate",
    entityId: key,
    before: before ? { subject: before.subject, body: before.body } : undefined,
    after: { subject: input.subject, body: input.body },
  });
}

export async function resetTemplateOverride(
  actorPersonId: string | null,
  key: string,
): Promise<void> {
  const before = await prisma.emailTemplate.findUnique({ where: { key } });
  if (!before) return;
  await prisma.emailTemplate.delete({ where: { key } });
  await recordAudit({
    actorPersonId,
    action: "email.template_reset",
    entityType: "EmailTemplate",
    entityId: key,
    before: { subject: before.subject, body: before.body },
  });
}

export type TemplateSummary = {
  key: string;
  name: string;
  category: TemplateDescriptor["category"];
  hasOverride: boolean;
  hasSenderOverride: boolean;
};

export async function listTemplateSummaries(): Promise<TemplateSummary[]> {
  const [overrides, senderRules] = await Promise.all([
    prisma.emailTemplate.findMany({ select: { key: true } }),
    listSenderRules(),
  ]);
  const overridden = new Set(overrides.map((o) => o.key));
  const senderOverridden = new Set(
    senderRules.filter((r) => r.scope === "TEMPLATE").map((r) => r.target)
  );
  return listDescriptors().map((d) => ({
    key: d.key,
    name: d.name,
    category: d.category,
    hasOverride: overridden.has(d.key),
    hasSenderOverride: senderOverridden.has(d.key),
  }));
}
