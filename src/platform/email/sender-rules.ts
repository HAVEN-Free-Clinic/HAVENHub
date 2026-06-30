/**
 * Per-category and per-template email sender resolution.
 *
 * Rules live in EmailSenderRule at two scopes: CATEGORY (keyed by a template
 * group) and TEMPLATE (keyed by a descriptor key). Resolution precedence for a
 * given template key is: TEMPLATE rule, then CATEGORY rule (by the template's
 * group), then null (the caller falls back to the global email.sender setting).
 *
 * The full rule set is tiny (at most one row per group plus one per template),
 * so it is cached in-memory and invalidated on every write. This keeps the
 * per-recipient campaign enqueue loop from issuing a DB read per row.
 */
import type { EmailSenderScope } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { getSetting } from "@/platform/settings/service";
import { getDescriptor } from "./templates/registry";
import type { TemplateGroup } from "./templates/types";

export type ResolvedSender = { fromEmail: string; fromName: string | null };

export type SenderRuleView = {
  scope: EmailSenderScope;
  target: string;
  fromEmail: string;
  fromName: string | null;
};

/** Categories shown in the admin sender UI. Excludes layout (never enqueued). */
export const SENDER_CATEGORIES: { group: TemplateGroup; label: string }[] = [
  { group: "recruitment", label: "Recruitment" },
  { group: "compliance", label: "Compliance" },
  { group: "epic", label: "Epic" },
  { group: "campaign", label: "Campaigns" },
];

export class SenderRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderRuleValidationError";
  }
}

// A pragmatic email check: non-space, an @, a dot in the domain. Semantic
// validity (Send-As rights) is confirmed by the admin via the test send.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cache: Map<string, SenderRuleView> | null = null;

function cacheKey(scope: EmailSenderScope, target: string): string {
  return `${scope}:${target}`;
}

/** Test-only: clear the in-memory rule cache between cases. */
export function _resetSenderRulesCache(): void {
  cache = null;
}

async function loadCache(): Promise<Map<string, SenderRuleView>> {
  if (cache) return cache;
  const rows = await prisma.emailSenderRule.findMany();
  const map = new Map<string, SenderRuleView>();
  for (const r of rows) {
    map.set(cacheKey(r.scope, r.target), {
      scope: r.scope,
      target: r.target,
      fromEmail: r.fromEmail,
      fromName: r.fromName,
    });
  }
  cache = map;
  return map;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The group a template key belongs to, for CATEGORY-rule lookup. */
export function groupForTemplate(templateKey: string): TemplateGroup | null {
  const d = getDescriptor(templateKey);
  if (d) return d.group;
  if (templateKey === "campaign" || templateKey.startsWith("campaign:")) return "campaign";
  return null;
}

/** Resolve the sender for a template key, or null to use the global default. */
export async function resolveSenderForTemplate(
  templateKey: string
): Promise<ResolvedSender | null> {
  const map = await loadCache();

  const templateRule = map.get(cacheKey("TEMPLATE", templateKey));
  if (templateRule) {
    return { fromEmail: templateRule.fromEmail, fromName: templateRule.fromName };
  }

  const group = groupForTemplate(templateKey);
  if (group) {
    const categoryRule = map.get(cacheKey("CATEGORY", group));
    if (categoryRule) {
      return { fromEmail: categoryRule.fromEmail, fromName: categoryRule.fromName };
    }
  }

  return null;
}

/**
 * The sender a template INHERITS, ignoring any TEMPLATE rule on it: the
 * CATEGORY rule for its group, else the global email.sender setting. Used to
 * show the admin what a blank per-template field falls back to.
 */
export async function resolveInheritedSender(templateKey: string): Promise<ResolvedSender> {
  const map = await loadCache();
  const group = groupForTemplate(templateKey);
  if (group) {
    const categoryRule = map.get(cacheKey("CATEGORY", group));
    if (categoryRule) {
      return { fromEmail: categoryRule.fromEmail, fromName: categoryRule.fromName };
    }
  }
  const globalSender = await getSetting<string>("email.sender");
  return { fromEmail: globalSender, fromName: null };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listSenderRules(): Promise<SenderRuleView[]> {
  const map = await loadCache();
  return [...map.values()];
}

export async function saveSenderRule(
  actorPersonId: string | null,
  scope: EmailSenderScope,
  target: string,
  input: { fromEmail: string; fromName?: string | null }
): Promise<void> {
  const fromEmail = input.fromEmail.trim();
  if (!EMAIL_RE.test(fromEmail)) {
    throw new SenderRuleValidationError(`"${input.fromEmail}" is not a valid email address.`);
  }
  const fromName = input.fromName?.trim() ? input.fromName.trim() : null;

  await prisma.emailSenderRule.upsert({
    where: { scope_target: { scope, target } },
    create: { scope, target, fromEmail, fromName, updatedById: actorPersonId },
    update: { fromEmail, fromName, updatedById: actorPersonId },
  });
  _resetSenderRulesCache();

  await recordAudit({
    actorPersonId,
    action: "email.sender_rule_save",
    entityType: "EmailSenderRule",
    entityId: `${scope}:${target}`,
    after: { fromEmail, fromName },
  });
}

export async function clearSenderRule(
  actorPersonId: string | null,
  scope: EmailSenderScope,
  target: string
): Promise<void> {
  const existing = await prisma.emailSenderRule.findUnique({
    where: { scope_target: { scope, target } },
  });
  if (!existing) return;

  await prisma.emailSenderRule.delete({ where: { scope_target: { scope, target } } });
  _resetSenderRulesCache();

  await recordAudit({
    actorPersonId,
    action: "email.sender_rule_clear",
    entityType: "EmailSenderRule",
    entityId: `${scope}:${target}`,
    before: { fromEmail: existing.fromEmail, fromName: existing.fromName },
  });
}
