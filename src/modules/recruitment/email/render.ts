import { prisma } from "@/platform/db";
import { getDescriptor } from "@/platform/email/templates/registry";
import { loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { renderTemplate } from "@/platform/email/render/render";
import { getSetting } from "@/platform/settings/service";

/** The recruitment emails that carry a cycle in their send context and can be
 *  overridden per cycle. recruitment.portal_link is global-only (no cycle). */
export const CYCLE_EMAIL_KEYS = [
  "recruitment.acceptance",
  "recruitment.interview_invite",
  "recruitment.onboarding",
  "recruitment.application_received",
] as const;
export type CycleEmailKey = (typeof CYCLE_EMAIL_KEYS)[number];

export type EmailSources = {
  subjectSource: string;
  bodySource: string;
  layoutSource: string;
  /** Resolved branding.brandColor, fed to the layout's {{ brandColor }} slot. */
  brandColor: string;
};

function assertCycleKey(key: string): asserts key is CycleEmailKey {
  if (!(CYCLE_EMAIL_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Not a cycle email key: ${key}`);
  }
}

/** Resolve subject/body/layout sources for a cycle email: cycle override ->
 *  global EmailTemplate override -> descriptor default. Layout stays global. */
export async function resolveCycleEmail(cycleId: string, key: CycleEmailKey): Promise<EmailSources> {
  assertCycleKey(key);
  const descriptor = getDescriptor(key);
  if (!descriptor) throw new Error(`Unknown email template: ${key}`);

  const [cycleOverride, globalOverride, layoutSource, brandColor] = await Promise.all([
    prisma.recruitmentCycleEmail.findUnique({ where: { cycleId_key: { cycleId, key } } }),
    prisma.emailTemplate.findUnique({ where: { key } }),
    loadLayoutSource(),
    getSetting<string>("branding.brandColor"),
  ]);

  return {
    subjectSource: cycleOverride?.subject ?? globalOverride?.subject ?? descriptor.defaultSubject,
    bodySource: cycleOverride?.body ?? globalOverride?.body ?? descriptor.defaultBody,
    layoutSource,
    brandColor,
  };
}

/** Render already-resolved sources with a context. Pure and synchronous, so the
 *  acceptance loop can resolve once and render per applicant. */
export function renderResolvedEmail(sources: EmailSources, context: Record<string, unknown>): { subject: string; html: string } {
  const subject = renderTemplate(sources.subjectSource, context);
  const body = renderTemplate(sources.bodySource, context);
  // brandColor first so a caller-supplied context value (rare) still wins.
  const html = renderTemplate(sources.layoutSource, { brandColor: sources.brandColor, ...context, subject, body });
  return { subject, html };
}

export async function renderCycleEmail(
  cycleId: string,
  key: CycleEmailKey,
  context: Record<string, unknown>,
): Promise<{ subject: string; html: string }> {
  const sources = await resolveCycleEmail(cycleId, key);
  return renderResolvedEmail(sources, context);
}
