import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { getSetting } from "@/platform/settings/service";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { resolveSupportAppId } from "@/platform/intercom/config";
import { IntercomMessenger } from "@/platform/intercom/messenger";

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

/**
 * /apply/verify is the magic-link sign-in confirmation screen -- a "sign-in
 * surface" by the same rule as /login: it exists to establish WHICH identity a
 * browser gets, so it always boots the Messenger as a visitor, never
 * conditionally, regardless of whatever session or cookie might already be
 * sitting on the request. Every other route under /apply is the actual
 * portal, where identity depends on live membership (see below).
 */
const SIGN_IN_SURFACE_PATH = "/apply/verify";

export default async function ApplyPortalLayout({ children }: { children: ReactNode }) {
  const supportAppId = resolveSupportAppId();
  // x-pathname is stamped by proxy.ts on every request (including the apply
  // subdomain's rewritten ones -- see its own doc comment), so this is the
  // one place that needs to know the real path; nothing downstream on the
  // identified branch does.
  const pathname = (await headers()).get("x-pathname");
  const isSignInSurface = pathname === SIGN_IN_SURFACE_PATH;
  return (
    <>
      {supportAppId ? (
        isSignInSurface ? (
          <IntercomMessenger appId={supportAppId} mode="visitor" />
        ) : (
          // requireActiveMembership: the portal's identity rule, ENFORCED by
          // the token route (see messenger-token/route.ts), not decided here.
          // This mounts unconditionally -- signed out, a bare Yale account
          // with no Person, a Person with no current ACTIVE term membership,
          // and a currently active member all reach the same call, and the
          // route sorts out which of them get a JWT back. The client falls
          // back to a visitor boot on its own when the route refuses (see
          // IntercomMessenger's doc comment), so nothing here needs to
          // pre-compute eligibility: a value decided once at render time
          // (here, or anywhere else short of the mint itself) is exactly the
          // gap a direct fetch to the token route could exploit, since only
          // the route's own live DB check cannot be bypassed by skipping the
          // page that would have said "visitor".
          <IntercomMessenger appId={supportAppId} mode="identified" requireActiveMembership />
        )
      ) : null}
      {children}
    </>
  );
}
