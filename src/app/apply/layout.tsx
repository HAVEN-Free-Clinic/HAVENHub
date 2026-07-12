import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getSetting } from "@/platform/settings/service";
import { buildPageMetadata } from "@/platform/branding/metadata";

/**
 * Metadata-only layout for the public application portal. The root layout sets
 * the browser-tab title to the hub's application name (branding.appName) for the
 * whole app; this override gives the /apply tree its own configurable title
 * (branding.applyPortalTitle) so the portal - including the apply subdomain -
 * reads e.g. "HAVEN Application Portal" instead of "HAVEN Hub". It renders no
 * markup of its own: the root layout owns <html>/<body>, and the portal pages own
 * their own shells (PortalShell).
 */
export async function generateMetadata(): Promise<Metadata> {
  const [title, orgName] = await Promise.all([
    getSetting<string>("branding.applyPortalTitle"),
    getSetting<string>("branding.orgName"),
  ]);
  return buildPageMetadata({ title, description: `Apply to ${orgName}` });
}

export default function ApplyPortalLayout({ children }: { children: ReactNode }) {
  return children;
}
