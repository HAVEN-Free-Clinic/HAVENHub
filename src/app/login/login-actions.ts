"use server";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/platform/auth/auth";
import { requestMemberLoginLink } from "@/platform/auth/member-magic-link";
import { safeLoginPath } from "@/platform/auth/safe-next";
import { captureEvent } from "@/platform/posthog/capture";

export type MemberLinkActionResult = { status: "sent" | "invalid" | "use-yale" };

/**
 * Start the Yale (Entra) sign-in. The front door for nearly everyone.
 *
 * A named export in a module of its own, rather than the inline closure that
 * used to live in page.tsx, for two reasons.
 *
 * The id. A Server Action's id is hashed from the build's encryption key plus
 * the module and export it belongs to. Pinning the key
 * (src/platform/server-actions-key.ts) settles the first half; a stable export
 * name settles the second. An inline action has no name of its own -- the
 * compiler assigns one from its position in the file -- so it can be renumbered
 * by an edit somewhere else in page.tsx, and the members holding the old bundle
 * are the ones who find out. `/login` is the tab people leave open longest, so
 * it is the worst page in the app to have a churning action id on.
 *
 * The redirect. The inline version closed over a `safeCallbackUrl` computed in
 * the page body by a second, hand-rolled copy of `safeLoginPath`. Two copies of
 * an open-redirect guard is one too many. `callbackUrl` now travels as a plain
 * hidden field and is re-sanitised HERE, on the server, which is also what makes
 * the field safe to accept: a tampered value is collapsed to "/" rather than
 * trusted because the page put it there.
 *
 * Mirrors `portalYaleSignInAction` in src/app/apply/portal-actions.ts, which has
 * had this shape from the start and has produced none of these errors.
 */
export async function signInWithYaleAction(formData: FormData): Promise<void> {
  const callbackUrl = safeLoginPath(String(formData.get("callbackUrl") ?? ""));
  try {
    await signIn("microsoft-entra-id", { redirectTo: callbackUrl });
  } catch (error) {
    // signIn signals SUCCESS by throwing NEXT_REDIRECT, so only a real AuthError
    // may be translated. Catching broadly would swallow the redirect and leave
    // the member on a button that appears to do nothing.
    if (error instanceof AuthError) {
      redirect(
        `/login?error=${error.type}&callbackUrl=${encodeURIComponent(callbackUrl)}`,
      );
    }
    throw error;
  }
}

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
