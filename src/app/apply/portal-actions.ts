"use server";
import { cookies } from "next/headers";
import { signOut } from "@/platform/auth/auth";
import { requestMagicLink, APPLICANT_COOKIE } from "@/modules/recruitment/services/portal-auth";

export async function requestMagicLinkAction(formData: FormData): Promise<{ ok: boolean }> {
  const email = String(formData.get("email") ?? "").trim();
  // Basic shape check; the email service normalizes + rate-limits.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false };
  // Carry the deep-link the applicant was headed to (e.g. /apply/<slug>) so the
  // emailed verify link returns them there; requestMagicLink sanitizes it.
  const next = String(formData.get("next") ?? "").trim() || null;
  await requestMagicLink(email, next);
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
