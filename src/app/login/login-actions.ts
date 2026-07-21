"use server";
import { requestMemberLoginLink } from "@/platform/auth/member-magic-link";
import { captureEvent } from "@/platform/posthog/capture";

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
