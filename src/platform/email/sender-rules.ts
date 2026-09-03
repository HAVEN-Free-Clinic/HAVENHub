/**
 * Per-category and per-template email sender resolution.
 *
 * Rules live in EmailSenderRule at two scopes: CATEGORY (keyed by a template
 * group) and TEMPLATE (keyed by a descriptor key). Resolution precedence for a
 * given template key is: TEMPLATE rule, then CATEGORY rule (by the template's
 * group), then null (the caller falls back to the global email.sender setting).
 *
 * THE ADDRESS AND THE DISPLAY NAME ARE RESOLVED SEPARATELY, and only the address
 * follows the order above. The name falls through a rule that has none to
 * `branding.orgName` (see orgDisplayName), which is why a template with no rule
 * at all can still return a sender: a null fromEmail with a name beside it. The
 * name is cosmetic and no part of DKIM or SPF alignment, so it can be resolved
 * from somewhere the address never could be.
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
import { EMAIL_RE } from "./address";

export type ResolvedSender = { fromEmail: string; fromName: string | null };

/**
 * What the ENQUEUE seam takes, where an address may be absent while a name is
 * not.
 *
 * A separate type from ResolvedSender because the two answer different
 * questions. ResolvedSender answers "what would this send as", which always has
 * an address (`resolveInheritedSender` falls all the way back to the global
 * setting to produce one) and is rendered to admins as placeholder text. This
 * one answers "what does the enqueue write onto the row", where a null
 * fromEmail is meaningful and load-bearing: it means NO RULE CHOSE AN ADDRESS,
 * so the transport's own default carries the message, exactly as it did when
 * resolveSenderForTemplate returned null outright. The org-name floor must never
 * turn that into a chosen address; naming a message is not the same decision as
 * routing it, and only one of the two is anywhere near DKIM.
 */
export type EnqueueSender = { fromEmail: string | null; fromName: string | null };

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
  { group: "shift", label: "Shift reminders" },
  { group: "support", label: "IT Support" },
  { group: "incidents", label: "Incident Reports" },
  { group: "volunteers", label: "Volunteers" },
  { group: "campaign", label: "Campaigns" },
  { group: "auth", label: "Authentication" },
];

export class SenderRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderRuleValidationError";
  }
}

// The address format check is EMAIL_RE, imported from ./address. It moved there
// so the sender-identity write seams share this exact pattern rather than
// inventing a second one. Semantic validity (Send-As rights) is still confirmed
// by the admin via the test send.

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const TTL_MS = 30_000;

let cache: { map: Map<string, SenderRuleView>; expiresAt: number } | null = null;

function cacheKey(scope: EmailSenderScope, target: string): string {
  return `${scope}:${target}`;
}

/** Test-only: clear the in-memory rule cache between cases. */
export function _resetSenderRulesCache(): void {
  cache = null;
}

async function loadCache(): Promise<Map<string, SenderRuleView>> {
  if (cache && cache.expiresAt > Date.now()) return cache.map;
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
  cache = { map, expiresAt: Date.now() + TTL_MS };
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

/**
 * The ORGANISATION's own name, and the last resort for any From display name.
 *
 * WHY THIS EXISTS. Every one of the six sender rules in production carries a
 * null `fromName`, and most templates have no rule at all, so ~4,347 system
 * emails in 60 days went out as a bare address. There is no "sending person" to
 * credit on a cron reminder, and the campaigns are no better off: 7 of 7 have no
 * explicit identity and therefore no chooser, so the person layer above this one
 * fires on none of them either.
 *
 * WHY NOT THE CREATOR, considered and rejected -- DO NOT RE-ADD IT. Falling back
 * to `EmailCampaign.createdById` would name most of these, and it would be
 * wrong: nobody chose to send as themselves. `Jack Carney
 * <haven.free.clinic@yale.edu>` reads as Jack's mail, on an address that is the
 * clinic's and that Jack never claimed. The person layer above deliberately
 * credits only `fromEmailSetById`, the person who ACTUALLY PICKED the identity,
 * for exactly this reason (see senderForRun). A creator picked a template, not a
 * voice. The org's name is the one thing that is true of every send here.
 *
 * NULL WHEN BLANK, and that has to stay a real answer. z.string().min(1) accepts
 * "   ", so an admin can reach a whitespace-only org name through the ordinary
 * settings screen; a From carrying an empty display name renders as a stray pair
 * of quotes and reads as a bug rather than as a plain address.
 *
 * Read through getSetting on every resolve (30s cache) rather than baked in, so
 * renaming the organisation reaches every message, and so this is the same value
 * the rest of the app shows.
 */
export async function orgDisplayName(): Promise<string | null> {
  const name = await getSetting<string>("branding.orgName");
  return name?.trim() || null;
}

/**
 * Resolve the sender for a template key.
 *
 * TWO INDEPENDENT HALVES, and conflating them is the mistake to avoid here. The
 * ADDRESS comes from a rule or from nowhere; when no rule matches, `fromEmail`
 * is null and the transport's own default carries the message, which is what
 * this function has always meant and what keeps routing and DKIM untouched. The
 * NAME falls through the rule to the org floor, so a rule with a null `fromName`
 * (all six of them) and a template with no rule at all are both named.
 *
 * Null is still returned when there is nothing at all to say -- no rule and no
 * org name -- so the enqueue behaves exactly as it did before the floor existed.
 */
export async function resolveSenderForTemplate(
  templateKey: string
): Promise<EnqueueSender | null> {
  const map = await loadCache();
  const org = await orgDisplayName();

  const templateRule = map.get(cacheKey("TEMPLATE", templateKey));
  if (templateRule) {
    return { fromEmail: templateRule.fromEmail, fromName: templateRule.fromName ?? org };
  }

  const group = groupForTemplate(templateKey);
  if (group) {
    const categoryRule = map.get(cacheKey("CATEGORY", group));
    if (categoryRule) {
      return { fromEmail: categoryRule.fromEmail, fromName: categoryRule.fromName ?? org };
    }
  }

  return org ? { fromEmail: null, fromName: org } : null;
}

/**
 * The sender a template INHERITS, ignoring any TEMPLATE rule on it: the
 * CATEGORY rule for its group, else the global email.sender setting. Used to
 * show the admin what a blank per-template field falls back to.
 *
 * The NAME half inherits the org floor for the same reason: this function exists
 * to tell an admin what leaving a field blank actually does, so it would be
 * showing them the wrong answer if it said "no name" while the send carried the
 * organisation's.
 */
export async function resolveInheritedSender(templateKey: string): Promise<ResolvedSender> {
  const map = await loadCache();
  const org = await orgDisplayName();
  const group = groupForTemplate(templateKey);
  if (group) {
    const categoryRule = map.get(cacheKey("CATEGORY", group));
    if (categoryRule) {
      return { fromEmail: categoryRule.fromEmail, fromName: categoryRule.fromName ?? org };
    }
  }
  const globalSender = await getSetting<string>("email.sender");
  return { fromEmail: globalSender, fromName: org };
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
