import { getSetting } from "@/platform/settings/service";

/**
 * The clinic/organization identity, distinct from the product name
 * (branding.appName). `name` is the clinic itself ("HAVEN Free Clinic");
 * `tagline` is an optional affiliation shown after it ("Yale University").
 */
export type OrgIdentity = { name: string; tagline: string };

/** Resolve the configurable organization name and tagline. */
export async function getOrgIdentity(): Promise<OrgIdentity> {
  const [name, tagline] = await Promise.all([
    getSetting<string>("branding.orgName"),
    getSetting<string>("branding.orgTagline"),
  ]);
  return { name, tagline };
}

/** "Name · Tagline", or just the name when the tagline is blank. */
export function formatOrgLine({ name, tagline }: OrgIdentity): string {
  return tagline.trim() ? `${name} · ${tagline}` : name;
}
