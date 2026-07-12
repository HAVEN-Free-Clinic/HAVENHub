import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getSetting } from "@/platform/settings/service";
import { buildPageMetadata } from "@/platform/branding/metadata";

/**
 * Metadata-only layout for the public application portal. The root layout gives
 * the whole app a "<Page> · <appName>" title template and a branded Open Graph
 * card. This override renders the /apply tree, including the apply subdomain,
 * with its own configurable title (branding.applyPortalTitle) standalone, e.g.
 * "HAVEN Application Portal" rather than "HAVEN Application Portal · HAVEN Hub",
 * so the portal reads as its own public brand while still using the shared
 * branded card. It renders no markup of its own: the root layout owns
 * <html>/<body>, and the portal pages own their own shells (PortalShell).
 */
export async function generateMetadata(): Promise<Metadata> {
  const [title, orgName] = await Promise.all([
    getSetting<string>("branding.applyPortalTitle"),
    getSetting<string>("branding.orgName"),
  ]);
  return buildPageMetadata({ title, description: `Apply to ${orgName}`, standalone: true });
}

export default function ApplyPortalLayout({ children }: { children: ReactNode }) {
  return children;
}
