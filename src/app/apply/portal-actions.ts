"use server";
import { cookies } from "next/headers";
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
}
