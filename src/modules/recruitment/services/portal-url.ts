import { config } from "@/platform/config";
import { getSetting } from "@/platform/settings/service";
import { buildPortalUrl } from "./portal-routing";

/**
 * Absolute, shareable public application URL for a cycle (or the portal home).
 * Uses PORTAL_BASE_URL when configured (pretty subdomain form), otherwise the
 * <app.baseUrl>/apply hub path so links keep working before the subdomain is live.
 */
export async function portalUrl(slug?: string): Promise<string> {
  const appBase = await getSetting<string>("app.baseUrl");
  return buildPortalUrl(config.PORTAL_BASE_URL, appBase, slug);
}
