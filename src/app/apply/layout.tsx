import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { resolveSupportAppId } from "@/platform/intercom/config";
import { IntercomMessenger } from "@/platform/intercom/messenger";
import { buildVisitorIdentityAttributes } from "@/platform/intercom/visitor";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";

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

/**
 * Who the portal signed this browser in as, formatted for an anonymous
 * Messenger boot (see platform/intercom/visitor.ts for what those attributes
 * are and what their evidence is worth).
 *
 * This is NOT the eligibility pre-computation the mount site below warns
 * against, and the distinction matters: that warning is about deciding at
 * render time WHO gets an identified boot, which is a decision only the token
 * route's live check may make. Nothing here decides anything. These values ride
 * a boot that is anonymous either way, they are never read on an identified
 * one, and a browser that skipped this page reaches the same token route and
 * gets the same answer.
 *
 * Name resolution mirrors the portal home's greeting, in the same order of
 * trust: the stored Person name for someone we already know, else the first
 * name from the Entra sign-in for a brand-new applicant, else nothing. The
 * magic-link path carries neither, so those visitors are attributed by email
 * alone rather than being given a name we would be inventing.
 */
async function resolveVisitorIdentityAttributes(): Promise<Record<string, string> | undefined> {
  const identity = await getApplicantIdentity();
  if (!identity) return undefined;
  const person = identity.personId
    ? await prisma.person.findUnique({ where: { id: identity.personId }, select: { name: true } })
    : null;
  return buildVisitorIdentityAttributes({
    name: person?.name ?? identity.firstName ?? null,
    email: identity.email,
  });
}

export default async function ApplyPortalLayout({ children }: { children: ReactNode }) {
  const supportAppId = resolveSupportAppId();
  // x-pathname is stamped by proxy.ts on every request (including the apply
  // subdomain's rewritten ones -- see its own doc comment), so this is the
  // one place that needs to know the real path; nothing downstream on the
  // identified branch does.
  const pathname = (await headers()).get("x-pathname");
  const isSignInSurface = pathname === SIGN_IN_SURFACE_PATH;
  // Skipped on the sign-in surface, and not merely to save the query: that
  // screen boots as a visitor precisely BECAUSE whatever session is already on
  // the request is not yet the identity this browser is establishing (see
  // SIGN_IN_SURFACE_PATH above). Labelling that boot with the outgoing session's
  // name is the one place these attributes would be actively wrong. Also skipped
  // when Intercom is off, since nothing mounts to receive them.
  const visitorAttributes =
    supportAppId && !isSignInSurface ? await resolveVisitorIdentityAttributes() : undefined;
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
          <IntercomMessenger
            appId={supportAppId}
            mode="identified"
            requireActiveMembership
            visitorAttributes={visitorAttributes}
          />
        )
      ) : null}
      {children}
    </>
  );
}
