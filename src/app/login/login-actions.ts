"use server";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/platform/auth/auth";
import { safeLoginPath } from "@/platform/auth/safe-next";
import { requestMemberLoginLink } from "@/platform/auth/member-magic-link";
import { captureEvent } from "@/platform/posthog/capture";

/**
 * Start Yale (Entra ID) SSO.
 *
 * A top-level module action reading its destination from a hidden field, NOT an
 * inline closure over the page's `safeCallbackUrl`. An inline closure carries a
 * per-build-encrypted reference a later deploy cannot resolve, which stranded
 * members on `/login` with a recurring `UnrecognizedActionError`; a top-level
 * action has a stable id across builds. Mirrors `portalYaleSignInAction`; see
 * `stale-server-action.ts` for the client-side backstop.
 */
export async function signInWithYaleAction(formData: FormData): Promise<void> {
  // The destination arrives through a client-controllable hidden field, so
  // re-validate it rather than trusting it.
  const callbackUrl = safeLoginPath(String(formData.get("callbackUrl") ?? ""));
  try {
    await signIn("microsoft-entra-id", { redirectTo: callbackUrl });
  } catch (error) {
    // signIn throws NEXT_REDIRECT on success, so only translate auth failures.
    if (error instanceof AuthError) {
      redirect(`/login?error=${error.type}&callbackUrl=${encodeURIComponent(callbackUrl)}`);
    }
    throw error;
  }
}

export type MemberLinkActionResult = { status: "sent" | "invalid" | "use-yale" };

export async function requestMemberLoginLinkAction(formData: FormData): Promise<MemberLinkActionResult> {
  // Field is named "memberEmail" (not "email") so it does not collide with the
  // dev-credentials form's input[name="email"] on the same /login page.
  const email = String(formData.get("memberEmail") ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { status: "invalid" };
  const next = String(formData.get("callbackUrl") ?? "").trim() || null;
  const result = await requestMemberLoginLink(email, next);
  await captureEvent({
    distinctId: email,
    event: "member_login_link_requested",
    properties: { result },
  });
  // Map "disabled" to the neutral "sent" so a direct POST cannot detect the toggle.
  return { status: result === "use-yale" ? "use-yale" : "sent" };
}
