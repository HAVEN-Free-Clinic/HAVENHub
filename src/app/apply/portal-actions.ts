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

/**
 * Remove the applicant from consideration.
 *
 * Takes the cycle SLUG, never an applicationId. The service re-derives the
 * identity and resolves the application from (slug, identity), so no identifier
 * carried by the request can select another applicant's row.
 */
export async function withdrawApplicationAction(slug: string): Promise<void> {
  const identity = await getApplicantIdentity();
  if (!identity) redirect("/apply");
  try {
    const { kind } = await withdrawApplication(slug, identity);
    await captureEvent({
      distinctId: identity.personId ?? identity.email,
      event: "application_withdrawn",
      properties: { slug, kind },
      groups: await termGroupForCycleSlug(slug),
    });
  } catch (err) {
    // A refusal (already withdrawn, promoted, raced) is not exceptional: the
    // portal re-renders and the card already shows the true current state.
    if (!(err instanceof WithdrawError)) throw err;
  }
  revalidatePath("/apply");
}

/** Throw away an unsubmitted draft and its uploads. */
export async function discardDraftAction(slug: string): Promise<void> {
  const identity = await getApplicantIdentity();
  if (!identity) redirect("/apply");
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
  }
  revalidatePath("/apply");
}
