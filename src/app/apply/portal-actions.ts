"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requestMagicLink, APPLICANT_COOKIE } from "@/modules/recruitment/services/portal-auth";

export async function requestMagicLinkAction(formData: FormData): Promise<{ ok: boolean }> {
  const email = String(formData.get("email") ?? "").trim();
  // Basic shape check; the email service normalizes + rate-limits.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false };
  await requestMagicLink(email);
  return { ok: true };
}

export async function applicantSignOutAction(): Promise<void> {
  const store = await cookies();
  store.delete(APPLICANT_COOKIE);
  // Redirect so the portal re-renders in the signed-out state. Without a fresh
  // navigation the page keeps showing the signed-in view (the deleted cookie is
  // not re-read), which is why the button appeared to do nothing.
  redirect("/apply");
}
