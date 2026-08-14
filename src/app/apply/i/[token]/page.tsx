import { redirect } from "next/navigation";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { peekInvite, claimInvite } from "@/modules/recruitment/services/invites";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { PortalShell } from "../../portal-shell";
import { PortalNotice } from "../../portal-notice";

export const dynamic = "force-dynamic";

/**
 * Claim page for a single-use recruitment invite link.
 *
 * THE ORDER OF THE THREE STEPS IS THE WHOLE DESIGN:
 *
 *  1. PEEK the token, without spending it. A visitor who merely opens the link
 *     -- or a mail scanner that prefetches it -- must not burn the invitation.
 *  2. Require sign-in, carrying `next` back to this same URL. The applicant
 *     proves an email address here, and that address is what the invite binds to.
 *  3. CLAIM, now that there is an identity to bind. From this point the token is
 *     spent and cannot admit anyone else, while the claimant keeps access through
 *     isInvitedTo for as long as they need to finish.
 *
 * Burning at step 1 instead would spend invitations on link previews and on
 * people who wandered off; never burning would leave a forwardable link live for
 * the days a multi-step application can take.
 *
 * A dead link (unknown, expired, revoked, already claimed) is reported as one
 * undifferentiated state. Distinguishing them would tell a stranger holding a
 * guessed token whether it ever existed.
 */
export default async function InviteClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const invite = await peekInvite(token);
  if (!invite) {
    const support = await getSupportContact();
    return (
      <PortalShell>
        <PortalNotice tone="neutral" title="This invitation link is no longer valid">
          <p>
            It may have already been used, been withdrawn, or expired. Invitation links work once
            and are personal to whoever accepts them first.
          </p>
          {support.email && (
            <p>
              <SupportLink email={support.email}>{support.label}</SupportLink>
            </p>
          )}
        </PortalNotice>
      </PortalShell>
    );
  }

  // Sign in first, then come back here. safeNextPath on the receiving end keeps
  // this to a relative path, and the token stays in the URL so the claim below
  // still has it after the round trip.
  const identity = await getApplicantIdentity();
  if (!identity) {
    redirect(`/apply?next=${encodeURIComponent(`/apply/i/${token}`)}`);
  }

  // Binds the invite to this applicant. Re-claiming by the same person is a
  // no-op success, so a refresh or a double sign-in does not read as a used link.
  const claimed = await claimInvite(token, identity.email);
  if (!claimed) {
    const support = await getSupportContact();
    return (
      <PortalShell>
        <PortalNotice tone="neutral" title="This invitation has already been accepted">
          <p>Invitation links work once, and this one was accepted by someone else.</p>
          {support.email && (
            <p>
              <SupportLink email={support.email}>{support.label}</SupportLink>
            </p>
          )}
        </PortalNotice>
      </PortalShell>
    );
  }

  redirect(`/apply/${invite.cycle.publicSlug}`);
}
