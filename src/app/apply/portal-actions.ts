"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { signOut } from "@/platform/auth/auth";
import { requestMagicLink, APPLICANT_COOKIE, getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { withdrawApplication, discardDraft, WithdrawError } from "@/modules/recruitment/services/withdraw";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroupForCycleSlug } from "@/platform/posthog/groups";

export async function requestMagicLinkAction(formData: FormData): Promise<{ ok: boolean }> {
  const email = String(formData.get("email") ?? "").trim();
  // Basic shape check; the email service normalizes + rate-limits.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false };
  // Carry the deep-link the applicant was headed to (e.g. /apply/<slug>) so the
  // emailed verify link returns them there; requestMagicLink sanitizes it.
  const next = String(formData.get("next") ?? "").trim() || null;
  await requestMagicLink(email, next);
  await captureEvent({
    distinctId: email,
    event: "applicant_magic_link_requested",
    properties: { has_next: !!next },
  });
  return { ok: true };
}

export async function applicantSignOutAction(): Promise<void> {
  // The portal identity comes from either the magic-link cookie or the Yale
  // (NextAuth) session, so signing out must clear BOTH. Deleting only the cookie
  // left an SSO-signed-in applicant still identified, so the button did nothing.
  const store = await cookies();
  store.delete(APPLICANT_COOKIE);
  // signOut clears the NextAuth session and redirects (a no-op session still
  // redirects), so the portal re-renders in the signed-out state.
  await signOut({ redirectTo: "/apply" });
}

/** useActionState result for the withdraw/discard controls: the message to show
 *  in an inline Alert, or null on success. */
export type WithdrawActionState = { error: string | null };

/**
 * Remove the applicant from consideration.
 *
 * Takes the cycle SLUG, never an applicationId. The service re-derives the
 * identity and resolves the application from (slug, identity), so no identifier
 * carried by the request can select another applicant's row.
 *
 * Bound with `.bind(null, slug)` before being handed to useActionState, so the
 * resulting signature is the `(prevState, formData)` shape that hook expects.
 * A refusal (already withdrawn, promoted, raced) is not rethrown: the applicant
 * needs to see why nothing happened, not hit the generic error boundary, and the
 * revalidate below refreshes the card to whatever the true current state is.
 */
export async function withdrawApplicationAction(
  slug: string,
  _prevState: WithdrawActionState,
  _formData: FormData,
): Promise<WithdrawActionState> {
  const identity = await getApplicantIdentity();
  if (!identity) redirect("/apply");
  let error: string | null = null;
  try {
    const { kind } = await withdrawApplication(slug, identity);
    await captureEvent({
      distinctId: identity.personId ?? identity.email,
      event: "application_withdrawn",
      properties: { slug, kind },
      groups: await termGroupForCycleSlug(slug),
    });
  } catch (err) {
    if (!(err instanceof WithdrawError)) throw err;
    error = err.message;
  }
  // Also revalidate on a refusal: the refusal itself (already withdrawn, raced,
  // promoted) means the card the applicant is looking at is stale, so it needs
  // the same refresh as the success path, alongside the message.
  revalidatePath("/apply");
  return { error };
}

/** Throw away an unsubmitted draft and its uploads. Same bind-then-useActionState
 *  shape as withdrawApplicationAction; see its comment. */
export async function discardDraftAction(
  slug: string,
  _prevState: WithdrawActionState,
  _formData: FormData,
): Promise<WithdrawActionState> {
  const identity = await getApplicantIdentity();
  if (!identity) redirect("/apply");
  let error: string | null = null;
  try {
    await discardDraft(slug, identity);
    await captureEvent({
      distinctId: identity.personId ?? identity.email,
      event: "application_draft_discarded",
      properties: { slug },
      groups: await termGroupForCycleSlug(slug),
    });
  } catch (err) {
    if (!(err instanceof WithdrawError)) throw err;
    error = err.message;
  }
  revalidatePath("/apply");
  return { error };
}
