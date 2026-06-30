import { getSetting } from "@/platform/settings/service";

/**
 * The user-facing support contact surfaced on signed-out pages (sign-in, 404,
 * welcome). `email` is the configured inbox, or "" when support links should be
 * hidden. `label` is the standalone link text, derived from the organization
 * name so a rebrand carries through automatically.
 */
export type SupportContact = { email: string; label: string };

/** Resolve the configurable support email and its derived link label. */
export async function getSupportContact(): Promise<SupportContact> {
  const [email, orgName] = await Promise.all([
    getSetting<string>("branding.supportEmail"),
    getSetting<string>("branding.orgName"),
  ]);
  return { email, label: `Contact the ${orgName} IT team` };
}
